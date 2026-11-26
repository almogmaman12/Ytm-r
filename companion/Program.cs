using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace YtmCompanion;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, @"Local\YtmRemoteCompanion", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new CompanionContext());
    }
}

internal sealed class Settings
{
    public string ExtensionFolder { get; set; } = "";
    public string PublicKey { get; set; } = "";
    public bool AutomaticUpdates { get; set; }
    public bool StartWithWindows { get; set; }
    public string Salt { get; set; } = "";
    public string PasswordHash { get; set; } = "";
}

internal static class Store
{
    public static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YTM Remote Companion");
    private static string FilePath => Path.Combine(Folder, "settings.json");
    public static Settings Load()
    {
        if (!File.Exists(FilePath)) return new Settings();
        return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? throw new InvalidDataException("Invalid companion settings.");
    }
    public static void Save(Settings s)
    {
        Directory.CreateDirectory(Folder);
        var temp = FilePath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(s));
        File.Move(temp, FilePath, true);
    }
    public static void SetPassword(Settings s, string password)
    {
        if (password.Length < 12) throw new ArgumentException("Use at least 12 characters.");
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
    public static void SetStartup(bool enabled)
    {
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
    private int failedUnlocks;
    private DateTime unlockAfter;
    private readonly ToolStripMenuItem statusItem = new("Not configured") { Enabled = false };

    public CompanionContext()
    {
        try { settings = Store.Load(); }
        catch { settings = new Settings(); status = "Settings could not be loaded; automatic updates disabled."; }
        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add("Settings…", null, (_, _) => OpenSettings());
        menu.Items.Add("Check for extension update", null, async (_, _) => await CheckAsync(true));
        menu.Items.Add("Open companion data folder", null, (_, _) =>
        {
            Directory.CreateDirectory(Store.Folder);
            Process.Start(new ProcessStartInfo(Store.Folder) { UseShellExecute = true });
        });
        menu.Items.Add("Exit", null, (_, _) => ExitThread());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "YTM Remote Companion", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => OpenSettings();
        statusItem.Text = status;
        timer.Tick += async (_, _) => await CheckAsync(false);
        timer.Start();
        if (string.IsNullOrEmpty(settings.PasswordHash)) OpenSettings();
        else if (settings.AutomaticUpdates) _ = CheckAsync(false);
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
        if (!Unlock()) return;
        settingsOpen = true;
        try
        {
            using var form = new SettingsForm(settings, status);
            if (form.ShowDialog() == DialogResult.OK)
            {
                var next = form.Result!;
                Store.SetStartup(next.StartWithWindows);
                Store.Save(next);
                settings = next;
                nextCheck = DateTime.MinValue;
                Status(next.AutomaticUpdates ? "Automatic extension updates enabled" : "Automatic extension updates off");
            }
        }
        catch { Status("Could not save settings."); }
        finally { settingsOpen = false; }
    }
    private async Task CheckAsync(bool manual)
    {
        if (busy || settingsOpen || string.IsNullOrEmpty(settings.PasswordHash) || (!manual && !settings.AutomaticUpdates)) return;
        if (!manual && DateTime.UtcNow < nextCheck) return;
        if (manual && !Unlock()) return;
        busy = true;
        nextCheck = DateTime.UtcNow.AddHours(6);
        try
        {
            Status("Checking signed extension release…");
            var result = await updater.CheckAsync(settings);
            Status(result);
            if (result == ExtensionUpdater.Waiting) nextCheck = DateTime.UtcNow.AddMinutes(2);
        }
        catch { Status("Update check failed safely; existing extension retained."); }
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
        Label("Trusted release public key (PEM). Obtain this from your own release signing setup.");
        var key = new TextBox { Text = current.PublicKey, Width = 525, Height = 90, Multiline = true, ScrollBars = ScrollBars.Vertical };
        panel.Controls.Add(key);
        var auto = new CheckBox { Text = "Automatically install verified extension updates while Chrome is closed", AutoSize = true, Checked = current.AutomaticUpdates };
        var startup = new CheckBox { Text = "Start YTM Remote Companion with Windows", AutoSize = true, Checked = current.StartWithWindows };
        panel.Controls.Add(auto); panel.Controls.Add(startup);
        Label(string.IsNullOrEmpty(current.PasswordHash) ? "Create a settings password (12+ characters)" : "New password (leave blank to keep current password)");
        var password = new TextBox { UseSystemPasswordChar = true, Width = 525 };
        panel.Controls.Add(password);
        Label("Confirm new password");
        var confirm = new TextBox { UseSystemPasswordChar = true, Width = 525 };
        panel.Controls.Add(confirm);
        Label("The password protects the companion settings UI, not against a Windows administrator. The tray icon remains available; routine update checks do not show pop-ups.");
        var save = new Button { Text = "Save settings", AutoSize = true };
        panel.Controls.Add(save);
        save.Click += (_, _) =>
        {
            try
            {
                var next = new Settings { ExtensionFolder = folder.Text.Trim(), PublicKey = key.Text.Trim(), AutomaticUpdates = auto.Checked, StartWithWindows = startup.Checked, Salt = current.Salt, PasswordHash = current.PasswordHash };
                if (auto.Checked || next.ExtensionFolder.Length > 0 || next.PublicKey.Length > 0)
                {
                    ExtensionUpdater.ValidateFolder(next.ExtensionFolder);
                    using var verify = ECDsa.Create();
                    verify.ImportFromPem(next.PublicKey);
                    if (verify.KeySize != 256) throw new ArgumentException("Use the trusted P-256 public key.");
                }
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
