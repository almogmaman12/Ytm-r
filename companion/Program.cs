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
        if (s.ExtensionFolder == null || s.PublicKey == null || s.Salt == null || s.PasswordHash == null)
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
        menu.Items.Add(statusItem);
        menu.Items.Add("Settings…", null, (_, _) => OpenSettings());
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
        if (!manual && DateTime.UtcNow < nextCheck) return;
        if (string.IsNullOrWhiteSpace(settings.EffectivePublicKey) || string.IsNullOrWhiteSpace(settings.ExtensionFolder))
        {
            Status("Extension updates not configured; select the extension folder and enable trusted updates in Settings.");
            return;
        }
        busy = true;
        try
        {
            if (manual && !Unlock()) return;
            nextCheck = DateTime.UtcNow.AddHours(6);
            Status("Checking signed extension release…");
            var result = await updater.CheckAsync(settings, manual && reviewPermissions ? ReviewPermissions : null);
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
                var next = new Settings { ExtensionFolder = folder.Text.Trim(), PublicKey = pinned ?? key.Text.Trim(), AutomaticUpdates = auto.Checked, StartWithWindows = startup.Checked, Salt = current.Salt, PasswordHash = current.PasswordHash };
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
