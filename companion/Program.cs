using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

namespace YtmCompanion;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        using var mutex = new Mutex(true, @"Local\YtmRemoteCompanion", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new CompanionContext(args.Contains("--background", StringComparer.OrdinalIgnoreCase)));
    }
}

internal sealed class Settings
{
    public string ExtensionFolder { get; set; } = "";
    public string PublicKey { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore]
    public string EffectivePublicKey => PublisherTrust.PublicKey ?? PublicKey;
    public bool AutomaticUpdates { get; set; }
    public bool StartWithWindows { get; set; }
    public string Salt { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string NativeConfig { get; set; } = ""; // DPAPI-protected; empty means disabled
    public bool NativeCompanionUpdates { get; set; } // Separate opt-in for updating the native app
    public bool NativeRemoteUpdates { get; set; } // Explicit local opt-in for owner-phone signed updates
    public bool NativeControls { get; set; } // Off by default, including existing installs
}

internal static class Store
{
    public static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YTM Remote Companion");
    private static string FilePath => Path.Combine(Folder, "settings.json");
    public static bool Exists => File.Exists(FilePath);
    public static Settings Load() => LoadFrom(FilePath);
    internal static Settings LoadFrom(string path)
    {
        if (!File.Exists(path)) return new Settings { PublicKey = PublisherTrust.PublicKey ?? "" };
        var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(path)) ?? throw new InvalidDataException("Invalid companion settings.");
        Validate(s);
        if (PublisherTrust.PublicKey is string pinned)
        {
            // A changed trust anchor must be explicitly approved in settings.
            if (!string.Equals(s.PublicKey.Trim(), pinned.Trim(), StringComparison.Ordinal))
                s.AutomaticUpdates = false;
            s.PublicKey = pinned;
        }
        return s;
    }
    private static void Validate(Settings s)
    {
        if (s.ExtensionFolder == null || s.PublicKey == null || s.Salt == null || s.PasswordHash == null || s.NativeConfig == null)
            throw new InvalidDataException("Invalid companion settings.");
        if (s.PasswordHash.Length == 0 || Convert.FromBase64String(s.Salt).Length != 32 ||
            Convert.FromBase64String(s.PasswordHash).Length != 32)
            throw new InvalidDataException("Invalid saved password configuration.");
    }
    public static void Save(Settings s) => SaveTo(s, FilePath);
    internal static void SaveTo(Settings s, string path)
    {
        Validate(s);
        var folder = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(folder);
        var temp = Path.Combine(folder, ".settings-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            // Complete and flush the new file before replacing the old one.
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, s);
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(path)) File.Replace(temp, path, null);
            else File.Move(temp, path);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
    public static void SetPassword(Settings s, string password)
    {
        if (password.Length < 6) throw new ArgumentException("Use at least 6 characters.");
        var salt = RandomNumberGenerator.GetBytes(32);
        s.Salt = Convert.ToBase64String(salt);
        s.PasswordHash = Convert.ToBase64String(Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, HashAlgorithmName.SHA256, 32));
    }
    public static bool Verify(Settings s, string password)
    {
        try
        {
            var actual = Rfc2898DeriveBytes.Pbkdf2(password, Convert.FromBase64String(s.Salt), 600000, HashAlgorithmName.SHA256, 32);
            return CryptographicOperations.FixedTimeEquals(actual, Convert.FromBase64String(s.PasswordHash));
        }
        catch { return false; }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFullName(ref uint length, System.Text.StringBuilder? name);
    public static bool Packaged { get { uint length = 0; return GetCurrentPackageFullName(ref length, null) == 122; } }
    public static void SetStartup(bool enabled)
    {
        if (Packaged) return; // MSIX startup is managed by Windows Startup Apps.
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) key.SetValue("YTM Remote Companion", "\"" + Environment.ProcessPath + "\" --background");
        else key.DeleteValue("YTM Remote Companion", false);
    }
}

internal sealed class CompanionContext : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 60000 };
    private readonly ExtensionUpdater updater = new();
    private readonly NativeMonitor native;
    private readonly Control dispatcher = new();
    private volatile PermissionReview? remotePreview;
    private volatile string? companionLatest;
    private volatile string companionMessage = "Check the signed MSIX channel.";
    private DateTime companionReviewUntil;
    private DateTime remotePreviewUntil; // UI-thread-only expiry; prevents the automatic updater racing a phone review.
    private volatile string? latestVersion;
    private volatile string remoteMessage = "Check for a signed extension release.";
    private Settings settings;
    private string status = "Not configured";
    private DateTime nextCheck = DateTime.MinValue;
    private bool busy;
    private bool settingsOpen;
    private bool settingsUnreadable;
    private bool firstTick = true;
    private readonly bool backgroundLaunch;
    private int failedUnlocks;
    private DateTime unlockAfter;
    private readonly ToolStripMenuItem statusItem = new("Not configured") { Enabled = false };

    public CompanionContext(bool background)
    {
        backgroundLaunch = background;
        _ = dispatcher.Handle; // Marshal remote updater work onto the same UI thread as the tray updater.
        native = new NativeMonitor(RemoteSnapshot, CompanionSnapshot, DispatchRemoteUpdate);
        try
        {
            settings = Store.Load();
            status = string.IsNullOrEmpty(settings.PasswordHash) ? "Setup required" :
                settings.AutomaticUpdates ? "Automatic extension updates enabled" : "Automatic extension updates off";
        }
        catch
        {
            settings = new Settings();
            settingsUnreadable = true;
            status = "Saved settings unreadable; updates disabled. Open Settings for details.";
        }
        var menu = new ContextMenuStrip();
        var version = typeof(Program).Assembly.GetName().Version?.ToString(4) ?? "Unknown";
        var channel = Store.Packaged ? "MSIX" : "Test EXE";
        menu.Items.Add(new ToolStripMenuItem($"Companion {version} ({channel})") { Enabled = false });
        menu.Items.Add(statusItem);
        menu.Items.Add("Settings…", null, (_, _) => OpenSettings());
        menu.Items.Add("Windows status connection…", null, (_, _) => ConfigureNative());
        menu.Items.Add("Check for extension update", null, async (_, _) => await CheckAsync(true));
        menu.Items.Add("Review signed update…", null, async (_, _) => await CheckAsync(true, true));
        menu.Items.Add("Open companion data folder", null, (_, _) =>
        {
            Directory.CreateDirectory(Store.Folder);
            Process.Start(new ProcessStartInfo(Store.Folder) { UseShellExecute = true });
        });
        menu.Items.Add("Exit", null, (_, _) => ExitThread());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "YTM Remote Companion", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => OpenSettings();
        statusItem.Text = status;
        // Begin only after the WinForms message loop is running. No modal UI on startup.
        timer.Interval = 1000;
        timer.Tick += async (_, _) =>
        {
            if (firstTick)
            {
                firstTick = false;
                timer.Interval = 60000;
                if (!backgroundLaunch && !settingsUnreadable && string.IsNullOrEmpty(settings.PasswordHash))
                    OpenSettings();
            }
            await CheckAsync(false);
        };
        timer.Start();
        if (!settingsUnreadable) native.Start(settings.NativeConfig, settings.NativeControls);
    }

    private void Status(string message)
    {
        status = message;
        statusItem.Text = message;
    }
    private bool Unlock()
    {
        if (string.IsNullOrEmpty(settings.PasswordHash)) return true;
        if (DateTime.UtcNow < unlockAfter)
        {
            MessageBox.Show("Too many attempts. Try again in a minute.", "YTM Remote Companion");
            return false;
        }
        using var prompt = new Form { Text = "Unlock companion settings", Width = 390, Height = 160, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var password = new TextBox { UseSystemPasswordChar = true, Dock = DockStyle.Top, Margin = new Padding(12) };
        var ok = new Button { Text = "Unlock", DialogResult = DialogResult.OK, Dock = DockStyle.Bottom };
        prompt.Controls.Add(password); prompt.Controls.Add(ok); prompt.AcceptButton = ok;
        if (prompt.ShowDialog() != DialogResult.OK) return false;
        if (Store.Verify(settings, password.Text)) { failedUnlocks = 0; return true; }
        if (++failedUnlocks >= 5) { unlockAfter = DateTime.UtcNow.AddMinutes(1); failedUnlocks = 0; }
        MessageBox.Show("Incorrect password.", "YTM Remote Companion");
        return false;
    }
    private void OpenSettings()
    {
        if (settingsOpen || busy) return;
        if (settingsUnreadable)
        {
            MessageBox.Show("Your saved settings could not be read. Automatic updates are disabled and the saved file has not been overwritten. Restore a known-good settings file or contact the maintainer.", "YTM Remote Companion");
            return;
        }
        if (!Unlock()) return;
        settingsOpen = true;
        try
        {
            using var form = new SettingsForm(settings, status);
            if (form.ShowDialog() == DialogResult.OK)
            {
                var next = form.Result!;
                Store.Save(next);
                settings = next;
                remotePreview = null; latestVersion = null; remoteMessage = "Check for a signed extension release.";
                nextCheck = DateTime.MinValue;
                try
                {
                    Store.SetStartup(next.StartWithWindows);
                    Status(next.AutomaticUpdates ? "Automatic extension updates enabled" : "Automatic extension updates off");
                }
                catch
                {
                    Status("Settings saved, but Windows startup registration failed. Check Startup Apps.");
                }
            }
        }
        catch { Status("Could not save settings."); }
        finally { settingsOpen = false; }
    }
    private void ConfigureNative()
    {
        if (busy || settingsOpen || settingsUnreadable || string.IsNullOrEmpty(settings.PasswordHash) || !Unlock()) return;
        settingsOpen = true;
        try
        {
            using var form = new Form { Text = "Windows status connection (test relay)", Width = 565, Height = 490,
                StartPosition = FormStartPosition.CenterScreen };
            var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(12) };
            form.Controls.Add(panel);
            void Label(string text) => panel.Controls.Add(new Label { Text = text, AutoSize = true, MaximumSize = new Size(510, 0) });
            Label("Test relay: " + NativeCredentials.Relay);
            Label("Share Windows status with your authenticated owner phone. Remote controls are optional and limited to audio, media keys and Chrome.");
            var enable = new CheckBox { Text = "Share Windows status with my owner phone", AutoSize = true, Checked = settings.NativeConfig.Length > 0 };
            panel.Controls.Add(enable);
            var control = new CheckBox { Text = "Allow remote Windows audio, media and Chrome controls", AutoSize = true, Checked = settings.NativeControls && enable.Checked, Enabled = enable.Checked };
            panel.Controls.Add(control);
            var updates = new CheckBox { Text = "Allow owner phone to review and install signed extension updates", AutoSize = true, Checked = settings.NativeRemoteUpdates && control.Checked, Enabled = control.Checked && enable.Checked };
            panel.Controls.Add(updates);
            var companionUpdates = new CheckBox { Text = "Allow owner phone to update the Windows companion itself", AutoSize = true, Checked = settings.NativeCompanionUpdates && control.Checked, Enabled = control.Checked && enable.Checked };
            panel.Controls.Add(companionUpdates);
            control.CheckedChanged += (_, _) => { companionUpdates.Enabled = control.Checked && enable.Checked; if (!companionUpdates.Enabled) companionUpdates.Checked = false; };
            control.CheckedChanged += (_, _) => { updates.Enabled = control.Checked && enable.Checked; if (!updates.Enabled) updates.Checked = false; };
            enable.CheckedChanged += (_, _) => { control.Enabled = enable.Checked; if (!enable.Checked) control.Checked = false; };
            Label("Remote update approval uses your authenticated owner phone; Chrome may still require its own permission confirmation.");
            Label("Chrome closes gracefully; unsaved work or confirmation dialogs may prevent closure. No shell commands are accepted.");
            Label("Test relay token (leave both fields blank to retain saved credentials)");
            var token = new TextBox { Width = 500, UseSystemPasswordChar = true };
            panel.Controls.Add(token);
            Label("Test relay PC code");
            var code = new TextBox { Width = 500, UseSystemPasswordChar = true };
            panel.Controls.Add(code);
            var save = new Button { Text = "Save", AutoSize = true };
            panel.Controls.Add(save);
            save.Click += (_, _) =>
            {
                try
                {
                    string config = "";
                    if (enable.Checked)
                    {
                        config = token.Text.Length == 0 && code.Text.Length == 0 && settings.NativeConfig.Length > 0
                            ? NativeCredentials.Unprotect(settings.NativeConfig).Protect()
                            : new NativeCredentials(token.Text.Trim(), code.Text).Protect();
                    }
                    var old = settings.NativeConfig;
                    var oldControls = settings.NativeControls;
                    var oldUpdates = settings.NativeRemoteUpdates;
                    var oldCompanionUpdates = settings.NativeCompanionUpdates;
                    settings.NativeConfig = config;
                    settings.NativeControls = enable.Checked && control.Checked;
                    settings.NativeRemoteUpdates = settings.NativeControls && updates.Checked;
                    settings.NativeCompanionUpdates = settings.NativeControls && companionUpdates.Checked;
                    try { Store.Save(settings); }
                    catch { settings.NativeConfig = old; settings.NativeControls = oldControls; settings.NativeRemoteUpdates = oldUpdates; settings.NativeCompanionUpdates = oldCompanionUpdates; throw; }
                    remotePreview = null; companionLatest = null; companionReviewUntil = DateTime.MinValue;
                    native.Start(config, settings.NativeControls);
                    form.Close();
                }
                catch { MessageBox.Show("Could not save connection. Enter a valid token and PC code, or disable the connection.", "Windows status"); }
            };
            form.ShowDialog();
        }
        finally { settingsOpen = false; }
    }
    private object CompanionSnapshot()
    {
        bool supported=CompanionUpdater.Supported();
        return new { supported, enabled=supported && !settingsUnreadable && settings.NativeControls && settings.NativeCompanionUpdates,
            current=CompanionUpdater.CurrentVersion().ToString(), latest=companionLatest, status=companionMessage };
    }

    private async Task<(bool ok,string message)> RemoteCompanionUpdate(string action,JsonElement value,CancellationToken ct)
    {
        if(ct.IsCancellationRequested || settingsUnreadable || !settings.NativeControls || !settings.NativeCompanionUpdates ||
            string.IsNullOrEmpty(settings.PasswordHash) || busy || settingsOpen || !CompanionUpdater.Supported())
            return (false,"Remote companion updates are disabled, unsupported or busy.");
        var approved=companionLatest;
        if(action=="companion_update" && (approved==null || approved!=value.GetString() || DateTime.UtcNow>=companionReviewUntil))
            return (false,"Check the companion release again before updating.");
        busy=true;
        bool queued=false;
        try
        {
            companionLatest=null;
            var latest=await CompanionUpdater.LatestAsync(ct);
            var current=CompanionUpdater.CurrentVersion();
            companionLatest=latest.ToString();
            if(latest<=current)
            {
                companionMessage="Companion is up to date.";
                return (true,companionMessage);
            }
            if(action=="companion_check")
            {
                companionReviewUntil=DateTime.UtcNow.AddMinutes(10);
                companionMessage="New MSIX version available. Review and approve the update.";
                return (true,companionMessage);
            }
            if(companionLatest!=approved)
            {
                companionReviewUntil=DateTime.MinValue;
                companionMessage="Release changed. Check again before approving.";
                return (false,companionMessage);
            }
            companionReviewUntil=DateTime.MinValue;
            companionMessage="Windows update requested. Companion may disconnect and restart.";
            queued=true;
            // Give the native relay time to return the acknowledgement before Windows closes the app.
            _=ApplyCompanionUpdate(ct);
            return (true,companionMessage);
        }
        catch
        {
            companionMessage="Could not read the trusted MSIX channel.";
            return (false,companionMessage);
        }
        finally { if(!queued)busy=false; }
    }

    private async Task ApplyCompanionUpdate(CancellationToken ct)
    {
        try
        {
            await Task.Delay(3000,ct);
            if(ct.IsCancellationRequested)return;
            await CompanionUpdater.InstallAsync();
            companionMessage="Windows finished processing the update. Refresh the PC status.";
        }
        catch { companionMessage="Windows could not complete the companion update. Check App Installer on the PC."; }
        finally { busy=false; Status(companionMessage); }
    }

    private object RemoteSnapshot()
    {
        var s = settings;
        var r = remotePreview;
        bool enabled = !settingsUnreadable && s.NativeControls && s.NativeRemoteUpdates && !string.IsNullOrEmpty(s.PasswordHash);
        return new
        {
            enabled,
            current = ExtensionUpdater.InstalledVersion(s.ExtensionFolder),
            latest = latestVersion,
            status = remoteMessage,
            review = enabled && r != null ? new { installed = r.InstalledVersion, version = r.ReleaseVersion,
                hash = r.ArchiveSha256.ToLowerInvariant(), details = r.Details } : null
        };
    }

    private Task<(bool ok, string message)> DispatchRemoteUpdate(string action, JsonElement value, CancellationToken ct)
    {
        var completion = new TaskCompletionSource<(bool ok, string message)>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            dispatcher.BeginInvoke(new Action(async () =>
            {
                try { completion.TrySetResult(action.StartsWith("companion_",StringComparison.Ordinal) ? await RemoteCompanionUpdate(action,value,ct) : await RemoteUpdate(action, value, ct)); }
                catch (Exception) { completion.TrySetResult((false, "Remote extension update failed.")); }
            }));
        }
        catch { completion.TrySetResult((false, "Companion is unavailable.")); }
        return completion.Task;
    }

    private async Task<(bool ok, string message)> RemoteUpdate(string action, JsonElement value, CancellationToken ct)
    {
        if (ct.IsCancellationRequested || settingsUnreadable || !settings.NativeControls || !settings.NativeRemoteUpdates ||
            string.IsNullOrEmpty(settings.PasswordHash) || busy || settingsOpen)
            return (false, "Remote updates are disabled or the companion is busy.");
        if (string.IsNullOrWhiteSpace(settings.ExtensionFolder) || string.IsNullOrWhiteSpace(settings.EffectivePublicKey))
            return (false, "Configure the extension folder and trusted publisher key first.");
        var approved = remotePreview;
        if (action == "extension_update" && (approved == null || DateTime.UtcNow >= remotePreviewUntil || !string.Equals(approved.ArchiveSha256,value.GetString(),StringComparison.OrdinalIgnoreCase)))
            return (false, "Check and review the signed update again.");
        busy = true;
        bool reopen = false;
        try
        {
            if (action == "extension_check")
            {
                remotePreview = null; latestVersion = null;
                remoteMessage = await updater.CheckAsync(settings, preview:r =>
                {
                    // Never truncate permission details. Larger reviews stay local.
                    if (JsonSerializer.Serialize(r.Details).Length <= 3000) { remotePreviewUntil = DateTime.UtcNow.AddMinutes(10); remotePreview = r; }
                }, latest:v=>latestVersion=v);
                if (remotePreview == null && remoteMessage.Contains("available; review"))
                    remoteMessage = "Permission review is too large for the phone. Review on the PC.";
            }
            else
            {
                remotePreview = null; latestVersion = null;
                remoteMessage = await updater.CheckAsync(settings, review:_=>true, latest:v=>latestVersion=v,
                    expectedReview:approved, beforeInstall:async () =>
                    {
                        if (ct.IsCancellationRequested) return false;
                        reopen = WindowsControls.ChromeOpen();
                        if (reopen) WindowsControls.Execute("chrome_close", default);
                        for (int i=0; i<20 && ExtensionUpdater.ChromeOpen(); i++)
                            await Task.Delay(1000,ct);
                        return !ct.IsCancellationRequested && !ExtensionUpdater.ChromeOpen();
                    });
                if (remoteMessage == ExtensionUpdater.Waiting)
                    remoteMessage = "Chrome is still running. Close it fully, then check and retry. No forced close.";
            }
            Status(remoteMessage);
            return (action == "extension_check" || remoteMessage.StartsWith("Extension "), remoteMessage);
        }
        catch
        {
            remotePreview = null;
            remoteMessage = "Signed release check or installation failed. Check the PC settings and network.";
            Status(remoteMessage);
            return (false,remoteMessage);
        }
        finally
        {
            if (reopen && !ExtensionUpdater.ChromeOpen())
            {
                try { WindowsControls.Execute("chrome_open", default); }
                catch { remoteMessage += " Chrome could not be relaunched; use Launch Chrome."; Status(remoteMessage); }
            }
            busy = false;
        }
    }

    private bool ReviewPermissions(PermissionReview review)
    {
        using var dialog = new Form { Text = "YTM Remote Companion - Review signed update", Width = 630, Height = 530, MinimumSize = new Size(440, 360), StartPosition = FormStartPosition.CenterScreen };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(15), ColumnCount = 1, RowCount = 4 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(550,0), Text = $"Verified signed extension: {review.InstalledVersion} to {review.ReleaseVersion}. Review the added and removed browser permissions below." });
        layout.Controls.Add(new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill, Text = review.Details + Environment.NewLine + "SHA-256: " + review.ArchiveSha256 });
        layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(550,0), Text = "Approval applies only to this signed release. Chrome may require its own permission approval. Review new access carefully. The previous extension folder will be backed up." });
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        var approve = new Button { Text = "Approve this update", DialogResult = DialogResult.OK, AutoSize = true };
        buttons.Controls.Add(cancel); buttons.Controls.Add(approve); layout.Controls.Add(buttons);
        dialog.Controls.Add(layout); dialog.CancelButton = cancel; dialog.Shown += (_,_) => cancel.Focus();
        return dialog.ShowDialog() == DialogResult.OK;
    }
    private async Task CheckAsync(bool manual, bool reviewPermissions = false)
    {
        if (busy || settingsOpen || settingsUnreadable || string.IsNullOrEmpty(settings.PasswordHash) || (!manual && !settings.AutomaticUpdates)) return;
        if (!manual && (DateTime.UtcNow < nextCheck || (remotePreview != null && DateTime.UtcNow < remotePreviewUntil))) return;
        if (string.IsNullOrWhiteSpace(settings.EffectivePublicKey) || string.IsNullOrWhiteSpace(settings.ExtensionFolder))
        {
            Status("Extension updates not configured; select the extension folder and enable trusted updates in Settings.");
            return;
        }
        busy = true;
        try
        {
            // Ordinary checks use the existing trusted publisher key. Only an explicit
            // permission-review action needs the local settings password.
            if (manual && reviewPermissions && !Unlock()) return;
            nextCheck = DateTime.UtcNow.AddHours(6);
            Status("Checking signed extension release…");
            remotePreview = null;
            var result = await updater.CheckAsync(settings, manual && reviewPermissions ? ReviewPermissions : null, latest:v=>latestVersion=v);
            remoteMessage = result;
            Status(result);
            if (result == ExtensionUpdater.Waiting) nextCheck = DateTime.UtcNow.AddMinutes(2);
            else if (result == ExtensionUpdater.NoRelease) nextCheck = DateTime.UtcNow.AddMinutes(30);
        }
        catch (HttpRequestException)
        { Status("Release download unavailable. Check GitHub or network access."); nextCheck = DateTime.UtcNow.AddMinutes(30); }
        catch (OperationCanceledException)
        { Status("Release download timed out. Check again later."); nextCheck = DateTime.UtcNow.AddMinutes(30); }
        catch (Exception ex) when (ex is InvalidDataException or CryptographicException or JsonException or FormatException)
        { Status("Release or extension validation failed. Review settings and release."); nextCheck = DateTime.UtcNow.AddHours(6); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { Status("Extension folder unavailable or file operation failed. Review settings."); nextCheck = DateTime.UtcNow.AddMinutes(30); }
        catch { Status("Unexpected update error. Check again later."); nextCheck = DateTime.UtcNow.AddMinutes(30); }
        finally { busy = false; }
    }
    protected override void ExitThreadCore()
    {
        native.Dispose();
        dispatcher.Dispose();
        timer.Stop();
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class SettingsForm : Form
{
    public Settings? Result { get; private set; }
    public SettingsForm(Settings current, string status)
    {
        Text = "YTM Remote Companion • Settings";
        Width = 620; Height = 560; StartPosition = FormStartPosition.CenterScreen;
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(16) };
        Controls.Add(panel);
        void Label(string text) => panel.Controls.Add(new Label { Text = text, AutoSize = true, MaximumSize = new Size(540, 0) });
        Label("Extension updates • " + status);
        Label("Select the exact folder currently loaded in chrome://extensions. Chrome profile files are never changed.");
        var folder = new TextBox { Text = current.ExtensionFolder, Width = 525 };
        panel.Controls.Add(folder);
        var browse = new Button { Text = "Choose extension folder", AutoSize = true };
        browse.Click += (_, _) => { using var picker = new FolderBrowserDialog(); if (picker.ShowDialog() == DialogResult.OK) folder.Text = picker.SelectedPath; };
        panel.Controls.Add(browse);
        var pinned = PublisherTrust.PublicKey;
        Label(pinned != null ? "Publisher verification is built in. No key entry is needed." : "Development build: signed updates require a trusted publisher key.");
        var keyToggle = new Button { Text = "Advanced: release verification key", AutoSize = true, Visible = pinned == null };
        panel.Controls.Add(keyToggle);
        var key = new TextBox { Text = current.EffectivePublicKey, Width = 525, Height = 90, Multiline = true, ScrollBars = ScrollBars.Vertical, Visible = false, ReadOnly = pinned != null };
        panel.Controls.Add(key);
        keyToggle.Click += (_, _) => { if (pinned == null) key.Visible = !key.Visible; };
        var auto = new CheckBox { Text = "Automatically install verified extension updates while Chrome is closed", AutoSize = true, Checked = current.AutomaticUpdates && !string.IsNullOrWhiteSpace(current.EffectivePublicKey), Enabled = !string.IsNullOrWhiteSpace(current.EffectivePublicKey) };
        key.TextChanged += (_, _) =>
        {
            auto.Enabled = !string.IsNullOrWhiteSpace(key.Text);
            if (!auto.Enabled) auto.Checked = false;
        };
        var startup = new CheckBox { Text = "Start YTM Remote Companion with Windows", AutoSize = true, Checked = current.StartWithWindows };
        panel.Controls.Add(auto); panel.Controls.Add(startup);
        if (Store.Packaged) { startup.Enabled = false; Label("For the MSIX edition, enable startup in Windows Settings > Apps > Startup."); }
        Label(string.IsNullOrEmpty(current.PasswordHash) ? "Create a settings password (6+ characters)" : "New password (leave blank to keep current password)");
        var password = new TextBox { UseSystemPasswordChar = true, Width = 525 };
        panel.Controls.Add(password);
        Label("Confirm new password");
        var confirm = new TextBox { UseSystemPasswordChar = true, Width = 525 };
        panel.Controls.Add(confirm);
        Label("Settings are saved immediately and retained after shutdown. Windows startup is quiet: no settings window or routine update notifications. The tray icon remains available. The password protects the settings UI, not against a Windows administrator.");
        var save = new Button { Text = "Save settings", AutoSize = true };
        panel.Controls.Add(save);
        save.Click += (_, _) =>
        {
            try
            {
                var next = new Settings { ExtensionFolder = folder.Text.Trim(), PublicKey = pinned ?? key.Text.Trim(), AutomaticUpdates = auto.Checked, StartWithWindows = startup.Checked, Salt = current.Salt, PasswordHash = current.PasswordHash, NativeConfig = current.NativeConfig, NativeControls = current.NativeControls, NativeRemoteUpdates = current.NativeRemoteUpdates, NativeCompanionUpdates = current.NativeCompanionUpdates };
                if (next.ExtensionFolder.Length > 0 || next.AutomaticUpdates)
                    ExtensionUpdater.ValidateFolder(next.ExtensionFolder);
                if (next.PublicKey.Length > 0)
                {
                    using var verify = ECDsa.Create();
                    verify.ImportFromPem(next.PublicKey);
                    if (verify.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7") throw new ArgumentException("Use the trusted P-256 public key.");
                }
                if (next.AutomaticUpdates && next.PublicKey.Length == 0)
                    throw new ArgumentException("Configure a trusted publisher key before enabling automatic updates.");
                if (password.Text.Length > 0 || string.IsNullOrEmpty(next.PasswordHash))
                {
                    if (password.Text != confirm.Text) throw new ArgumentException("Passwords do not match.");
                    Store.SetPassword(next, password.Text);
                }
                Result = next; DialogResult = DialogResult.OK; Close();
            }
            catch (Exception ex) when (ex is ArgumentException or IOException or CryptographicException or InvalidDataException)
            { MessageBox.Show(ex.Message, "Cannot save settings"); }
        };
    }
}
