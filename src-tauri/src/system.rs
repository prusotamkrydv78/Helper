//! System information (read-only) and explicitly approved system actions.
//! `system_status` reports CPU, memory, fixed drives, network reachability and
//! the top processes; `system_end_process` ends one ordinary user process after
//! approval. Windows-only; other platforms report the tools as unsupported.

use serde::Deserialize;
use serde_json::Value;

use crate::tools::{ToolError, ToolOutput, ToolSpec};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EndArgs {
    pid: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VolumeArgs {
    /// 0–100.
    level: Option<u32>,
    mute: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MicArgs {
    mute: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WifiArgs {
    /// connect | disconnect
    action: String,
    /// Network name (SSID) with a saved profile, for connect.
    ssid: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PowerArgs {
    /// sleep | restart | shutdown | cancel_shutdown
    action: String,
}

/// Restart/shutdown are scheduled this many seconds ahead so they can be cancelled.
const SHUTDOWN_DELAY_SECS: u32 = 60;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsArgs {
    page: String,
}

/// What can be changed directly for a settings page, and why not otherwise.
fn direct_control(page: &str) -> &'static str {
    match page {
        "sound" => "Volume, mute and microphone mute can be changed directly (system_set_volume, system_set_microphone). Choosing the default output/input device has no public Windows API: pick it on this page.",
        "display" => "Brightness, resolution and scaling have no supported API here (laptop brightness needs WMI); change them on this page.",
        "night_light" | "focus" => "Windows has no documented API for this toggle; change it on this page.",
        "wifi" | "network" => "Wi-Fi status, networks, connecting to saved networks and disconnecting are direct (system_wifi_status, system_wifi). Joining a new network that needs a password, and turning the radio on/off, happen on this page.",
        "bluetooth" => "Bluetooth has no integrated API here; change it on this page.",
        _ => "No direct control; the user (or app_* tools, with approval) changes settings on this page.",
    }
}

/// Windows Settings pages the assistant may open (documented ms-settings: URIs).
const SETTINGS_PAGES: &[(&str, &str)] = &[
    ("display", "ms-settings:display"),
    ("night_light", "ms-settings:nightlight"),
    ("sound", "ms-settings:sound"),
    ("bluetooth", "ms-settings:bluetooth"),
    ("network", "ms-settings:network-status"),
    ("wifi", "ms-settings:network-wifi"),
    ("battery", "ms-settings:batterysaver"),
    ("power", "ms-settings:powersleep"),
    ("notifications", "ms-settings:notifications"),
    ("focus", "ms-settings:quiethours"),
    ("apps", "ms-settings:appsfeatures"),
    ("default_apps", "ms-settings:defaultapps"),
    ("startup_apps", "ms-settings:startupapps"),
    ("storage", "ms-settings:storagesense"),
    ("windows_update", "ms-settings:windowsupdate"),
    ("privacy", "ms-settings:privacy"),
];

/// Processes that keep Windows running or protect it; never ended.
const PROTECTED: &[&str] = &[
    "system", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe",
    "dwm.exe", "explorer.exe", "fontdrvhost.exe", "lsaiso.exe", "sihost.exe", "msmpeng.exe", "securityhealthservice.exe",
];

/// Primary local address, if there is a route to the internet (no packets are sent).
fn network() -> Value {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").and_then(|s| s.connect("8.8.8.8:53").map(|_| s)).and_then(|s| s.local_addr());
    match probe {
        Ok(addr) => serde_json::json!({ "route_to_internet": true, "local_ip": addr.ip().to_string() }),
        Err(_) => serde_json::json!({ "route_to_internet": false }),
    }
}

pub fn approval_reason(spec: &ToolSpec, args: &Value) -> Result<Option<String>, ToolError> {
    match spec.name {
        "system_end_process" => {
            let a: EndArgs = crate::tools::parse(args)?;
            let name = imp::check_endable(a.pid)?;
            Ok(Some(format!("End {name} (process {}). Unsaved work in it will be lost.", a.pid)))
        }
        "system_lock" => Ok(Some("Lock this computer now (you'll need to sign in again)".into())),
        "system_set_microphone" => {
            let a: MicArgs = crate::tools::parse(args)?;
            Ok(Some(if a.mute { "Mute the default microphone".into() } else { "Unmute the default microphone (apps can hear you again)".into() }))
        }
        "system_wifi" => {
            let a: WifiArgs = crate::tools::parse(args)?;
            match a.action.as_str() {
                "connect" => {
                    let ssid = a.ssid.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| ToolError::invalid("Give the `ssid` to connect to."))?;
                    Ok(Some(format!("Connect Wi-Fi to “{ssid}” (uses its saved profile). The current connection drops briefly.")))
                }
                "disconnect" => Ok(Some("Disconnect Wi-Fi. WARNING: the assistant itself may lose internet and stop responding until you reconnect.".into())),
                other => Err(ToolError::invalid(format!("`action` must be connect or disconnect, not `{other}`."))),
            }
        }
        "system_power" => {
            let a: PowerArgs = crate::tools::parse(args)?;
            Ok(Some(match a.action.as_str() {
                "sleep" => "Put the computer to sleep now. Running tasks pause; unsaved work stays in memory.".into(),
                "restart" => format!("RESTART the computer in {SHUTDOWN_DELAY_SECS} seconds. Unsaved work in open apps may be lost; apps get a chance to ask to save. This app and its tasks stop. Cancel with system_power cancel_shutdown or `shutdown /a`."),
                "shutdown" => format!("SHUT DOWN the computer in {SHUTDOWN_DELAY_SECS} seconds. Unsaved work in open apps may be lost; apps get a chance to ask to save. This app and its tasks stop."),
                "cancel_shutdown" => "Cancel a pending restart/shutdown".into(),
                other => return Err(ToolError::invalid(format!("`action` must be sleep, restart, shutdown or cancel_shutdown, not `{other}`."))),
            }))
        }
        "system_set_volume" => {
            let a: VolumeArgs = crate::tools::parse(args)?;
            let mut parts = Vec::new();
            if let Some(l) = a.level {
                if l > 100 {
                    return Err(ToolError::invalid("`level` must be 0–100."));
                }
                parts.push(format!("set the volume to {l}%"));
            }
            if let Some(m) = a.mute {
                parts.push(if m { "mute".into() } else { "unmute".into() });
            }
            if parts.is_empty() {
                return Err(ToolError::invalid("Give `level` and/or `mute`."));
            }
            Ok(Some(format!("System sound: {}", parts.join(" and "))))
        }
        _ => Ok(None),
    }
}

pub fn execute(spec: &ToolSpec, args: &Value) -> Result<ToolOutput, ToolError> {
    match spec.name {
        "system_status" => {
            let mut v = imp::status()?;
            v["network"] = network();
            let summary = format!(
                "CPU {}%, memory {}% used",
                v["cpu_percent"].as_f64().map(|c| c.round()).unwrap_or(0.0),
                v["memory"]["used_percent"].as_u64().unwrap_or(0)
            );
            Ok(ToolOutput { content: v, summary, file: None })
        }
        "system_set_volume" => {
            let a: VolumeArgs = crate::tools::parse(args)?;
            let (level, muted) = imp::set_volume(a.level.map(|l| l.min(100) as f32 / 100.0), a.mute)?;
            Ok(ToolOutput {
                content: serde_json::json!({ "volume_percent": level, "muted": muted, "verified": true }),
                summary: format!("Volume {level}%{}", if muted { " (muted)" } else { "" }),
                file: None,
            })
        }
        "system_audio_devices" => {
            let v = imp::audio_devices()?;
            let n = v["outputs"].as_array().map_or(0, Vec::len) + v["inputs"].as_array().map_or(0, Vec::len);
            Ok(ToolOutput {
                content: v,
                summary: format!("{n} audio devices"),
                file: None,
            })
        }
        "system_set_microphone" => {
            let a: MicArgs = crate::tools::parse(args)?;
            let muted = imp::set_mic_mute(a.mute)?;
            Ok(ToolOutput {
                content: serde_json::json!({ "microphone_muted": muted, "verified": muted == a.mute }),
                summary: if muted { "Microphone muted".into() } else { "Microphone unmuted".into() },
                file: None,
            })
        }
        "system_wifi_status" => {
            let v = imp::wifi_status()?;
            let n = v["networks"].as_array().map_or(0, Vec::len);
            Ok(ToolOutput { content: v, summary: format!("{n} Wi-Fi networks visible"), file: None })
        }
        "system_wifi" => {
            let a: WifiArgs = crate::tools::parse(args)?;
            let v = match a.action.as_str() {
                "connect" => imp::wifi_connect(a.ssid.as_deref().unwrap_or_default().trim())?,
                _ => imp::wifi_disconnect()?,
            };
            let summary = v["summary"].as_str().unwrap_or_default().to_owned();
            Ok(ToolOutput { content: v, summary, file: None })
        }
        "system_power" => {
            let a: PowerArgs = crate::tools::parse(args)?;
            let note = imp::power(&a.action)?;
            Ok(ToolOutput {
                content: serde_json::json!({ "action": a.action, "note": note }),
                summary: note.clone(),
                file: None,
            })
        }
        "system_lock" => {
            imp::lock()?;
            Ok(ToolOutput { content: serde_json::json!({ "locked": true }), summary: "Locked the computer".into(), file: None })
        }
        "system_open_settings" => {
            let a: SettingsArgs = crate::tools::parse(args)?;
            let uri = SETTINGS_PAGES
                .iter()
                .find(|(k, _)| *k == a.page.trim())
                .map(|(_, u)| *u)
                .ok_or_else(|| ToolError::invalid(format!("Unknown settings page. Use one of: {}.", SETTINGS_PAGES.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "))))?;
            imp::open_uri(uri)?;
            Ok(ToolOutput {
                content: serde_json::json!({ "opened": uri, "direct_control": direct_control(a.page.trim()) }),
                summary: format!("Opened Settings: {}", a.page.trim()),
                file: None,
            })
        }
        "system_end_process" => {
            let a: EndArgs = crate::tools::parse(args)?;
            let name = imp::end(a.pid)?;
            Ok(ToolOutput {
                content: serde_json::json!({ "ended": name, "pid": a.pid }),
                summary: format!("Ended {name} ({})", a.pid),
                file: None,
            })
        }
        other => Err(ToolError::invalid(format!("Unknown tool `{other}`."))),
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    fn unsupported() -> ToolError {
        ToolError::new("unsupported", "System tools are only available on Windows.")
    }
    pub fn status() -> Result<Value, ToolError> {
        Err(unsupported())
    }
    pub fn check_endable(_: u32) -> Result<String, ToolError> {
        Err(unsupported())
    }
    pub fn end(_: u32) -> Result<String, ToolError> {
        Err(unsupported())
    }
    pub fn set_volume(_: Option<f32>, _: Option<bool>) -> Result<(u32, bool), ToolError> {
        Err(unsupported())
    }
    pub fn open_uri(_: &str) -> Result<(), ToolError> {
        Err(unsupported())
    }
    pub fn lock() -> Result<(), ToolError> {
        Err(unsupported())
    }
    pub fn trigger_state() -> Result<Value, ToolError> {
        Err(unsupported())
    }
    pub fn audio_devices() -> Result<Value, ToolError> {
        Err(unsupported())
    }
    pub fn set_mic_mute(_: bool) -> Result<bool, ToolError> {
        Err(unsupported())
    }
    pub fn wifi_status() -> Result<Value, ToolError> {
        Err(unsupported())
    }
    pub fn wifi_connect(_: &str) -> Result<Value, ToolError> {
        Err(unsupported())
    }
    pub fn wifi_disconnect() -> Result<Value, ToolError> {
        Err(unsupported())
    }
    pub fn power(_: &str) -> Result<String, ToolError> {
        Err(unsupported())
    }
}

#[cfg(windows)]
mod imp {
    use serde_json::{json, Value};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::{
        GetSystemTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    use windows::Win32::Security::TOKEN_QUERY;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::PROTECTED;
    use crate::tools::ToolError;

    const DRIVE_FIXED: u32 = 3;
    const TOP_PROCESSES: usize = 25;

    fn ft(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }

    fn cpu_times() -> Option<(u64, u64)> {
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
        // Kernel time includes idle time.
        Some((ft(idle), ft(kernel) + ft(user)))
    }

    fn processes() -> Vec<(u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut e).is_ok();
            while ok {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                out.push((e.th32ProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                ok = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn working_set(pid: u32) -> Option<u64> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut c = PROCESS_MEMORY_COUNTERS::default();
            let ok = K32GetProcessMemoryInfo(h, &mut c, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32).as_bool();
            let _ = CloseHandle(h);
            ok.then_some(c.WorkingSetSize as u64)
        }
    }

    fn battery() -> Value {
        let mut p = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut p) }.is_err() {
            return json!(null);
        }
        // BatteryFlag 128 = no system battery; 255 = unknown.
        if p.BatteryFlag & 128 != 0 {
            return json!({ "present": false, "on_ac_power": p.ACLineStatus == 1 });
        }
        json!({
            "present": true,
            "percent": (p.BatteryLifePercent != 255).then_some(p.BatteryLifePercent),
            "on_ac_power": p.ACLineStatus == 1,
            "charging": p.BatteryFlag & 8 != 0,
            "minutes_left": (p.BatteryLifeTime != u32::MAX).then(|| p.BatteryLifeTime / 60),
        })
    }

    struct Com(bool);
    impl Com {
        fn init() -> Self {
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() }
            }
        }
    }

    fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let dev = e.GetDefaultAudioEndpoint(eRender, eConsole)?;
            dev.Activate(CLSCTX_ALL, None)
        }
    }

    fn audio() -> Value {
        let _com = Com::init();
        let read = || -> windows::core::Result<(f32, bool)> {
            let v = endpoint()?;
            unsafe { Ok((v.GetMasterVolumeLevelScalar()?, v.GetMute()?.as_bool())) }
        };
        match read() {
            Ok((level, muted)) => json!({ "volume_percent": (level * 100.0).round() as u32, "muted": muted }),
            Err(_) => json!({ "available": false }),
        }
    }

    /// Changes the default output device's volume/mute and returns the state read back afterwards.
    pub fn set_volume(level: Option<f32>, mute: Option<bool>) -> Result<(u32, bool), ToolError> {
        let _com = Com::init();
        let e = |e: windows::core::Error| ToolError::new("system_error", format!("Audio: {e}"));
        let v = endpoint().map_err(|_| ToolError::not_found("No default audio output device."))?;
        unsafe {
            if let Some(l) = level {
                v.SetMasterVolumeLevelScalar(l.clamp(0.0, 1.0), std::ptr::null()).map_err(e)?;
            }
            if let Some(m) = mute {
                v.SetMute(m, std::ptr::null()).map_err(e)?;
            }
            Ok(((v.GetMasterVolumeLevelScalar().map_err(e)? * 100.0).round() as u32, v.GetMute().map_err(e)?.as_bool()))
        }
    }

    fn endpoint_for(flow: windows::Win32::Media::Audio::EDataFlow) -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            e.GetDefaultAudioEndpoint(flow, eConsole)?.Activate(CLSCTX_ALL, None)
        }
    }

    /// Active output and input devices with friendly names; the defaults are marked.
    pub fn audio_devices() -> Result<Value, ToolError> {
        use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
        use windows::Win32::Media::Audio::{eCapture, DEVICE_STATE_ACTIVE};
        use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};
        let _com = Com::init();
        let e = |e: windows::core::Error| ToolError::new("system_error", format!("Audio: {e}"));
        let list = |flow| -> Result<Vec<Value>, ToolError> {
            unsafe {
                let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(e)?;
                let id_of = |d: &windows::Win32::Media::Audio::IMMDevice| -> Option<String> {
                    let p = d.GetId().ok()?;
                    let s = p.to_string().ok();
                    CoTaskMemFree(Some(p.0 as *const _));
                    s
                };
                let default_id = en.GetDefaultAudioEndpoint(flow, eConsole).ok().and_then(|d| id_of(&d));
                let col = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE).map_err(e)?;
                let mut out = Vec::new();
                for i in 0..col.GetCount().map_err(e)? {
                    let Ok(d) = col.Item(i) else { continue };
                    let name = d
                        .OpenPropertyStore(STGM_READ)
                        .and_then(|ps| ps.GetValue(&PKEY_Device_FriendlyName))
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| "Unknown device".into());
                    let id = id_of(&d);
                    out.push(json!({ "name": name, "default": id.is_some() && id == default_id }));
                }
                Ok(out)
            }
        };
        Ok(json!({
            "outputs": list(eRender)?,
            "inputs": list(eCapture)?,
            "note": "Windows has no public API to change the default device; use system_open_settings with page \"sound\".",
        }))
    }

    /// Mutes/unmutes the default microphone and returns the state read back.
    pub fn set_mic_mute(mute: bool) -> Result<bool, ToolError> {
        use windows::Win32::Media::Audio::eCapture;
        let _com = Com::init();
        let e = |e: windows::core::Error| ToolError::new("system_error", format!("Microphone: {e}"));
        let v = endpoint_for(eCapture).map_err(|_| ToolError::not_found("No default microphone."))?;
        unsafe {
            v.SetMute(mute, std::ptr::null()).map_err(e)?;
            Ok(v.GetMute().map_err(e)?.as_bool())
        }
    }

    // ---- Wi-Fi (Native Wifi API) ----

    struct Wlan(windows::Win32::Foundation::HANDLE);
    impl Wlan {
        fn open() -> Result<Self, ToolError> {
            use windows::Win32::NetworkManagement::WiFi::WlanOpenHandle;
            let (mut ver, mut h) = (0u32, windows::Win32::Foundation::HANDLE::default());
            let code = unsafe { WlanOpenHandle(2, None, &mut ver, &mut h) };
            if code != 0 {
                return Err(ToolError::new("unsupported", format!("Wi-Fi isn't available (WLAN service error {code}).")));
            }
            Ok(Wlan(h))
        }
        fn interface(&self) -> Result<windows::core::GUID, ToolError> {
            use windows::Win32::NetworkManagement::WiFi::{WlanEnumInterfaces, WlanFreeMemory, WLAN_INTERFACE_INFO_LIST};
            unsafe {
                let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
                if WlanEnumInterfaces(self.0, None, &mut list) != 0 || list.is_null() {
                    return Err(ToolError::not_found("No Wi-Fi adapter found."));
                }
                let n = (*list).dwNumberOfItems as usize;
                let guid = (n > 0).then(|| (*list).InterfaceInfo.as_ptr().read().InterfaceGuid);
                WlanFreeMemory(list as *const _);
                guid.ok_or_else(|| ToolError::not_found("No Wi-Fi adapter found."))
            }
        }
        /// (ssid, signal %, secured, connected, saved profile name)
        fn networks(&self, guid: &windows::core::GUID) -> Result<Vec<(String, u32, bool, bool, Option<String>)>, ToolError> {
            use windows::Win32::NetworkManagement::WiFi::{WlanFreeMemory, WlanGetAvailableNetworkList, WLAN_AVAILABLE_NETWORK_LIST};
            const CONNECTED: u32 = 1;
            const HAS_PROFILE: u32 = 2;
            unsafe {
                let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = std::ptr::null_mut();
                if WlanGetAvailableNetworkList(self.0, guid, 0, None, &mut list) != 0 || list.is_null() {
                    return Err(ToolError::new("system_error", "Couldn't read Wi-Fi networks."));
                }
                let items = std::slice::from_raw_parts((*list).Network.as_ptr(), (*list).dwNumberOfItems as usize);
                let mut out: Vec<(String, u32, bool, bool, Option<String>)> = Vec::new();
                for n in items {
                    let len = (n.dot11Ssid.uSSIDLength as usize).min(32);
                    let ssid = String::from_utf8_lossy(&n.dot11Ssid.ucSSID[..len]).into_owned();
                    if ssid.is_empty() {
                        continue;
                    }
                    let pl = n.strProfileName.iter().position(|&c| c == 0).unwrap_or(0);
                    let profile = (n.dwFlags & HAS_PROFILE != 0 && pl > 0).then(|| String::from_utf16_lossy(&n.strProfileName[..pl]));
                    let connected = n.dwFlags & CONNECTED != 0;
                    // The list has one entry per profile; keep the best per SSID.
                    if let Some(e) = out.iter_mut().find(|e| e.0 == ssid) {
                        e.1 = e.1.max(n.wlanSignalQuality);
                        e.3 |= connected;
                        e.4 = e.4.take().or(profile);
                    } else {
                        out.push((ssid, n.wlanSignalQuality, n.bSecurityEnabled.as_bool(), connected, profile));
                    }
                }
                WlanFreeMemory(list as *const _);
                out.sort_by(|a, b| b.1.cmp(&a.1));
                Ok(out)
            }
        }
    }
    impl Drop for Wlan {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::NetworkManagement::WiFi::WlanCloseHandle(self.0, None);
            }
        }
    }

    pub fn wifi_status() -> Result<Value, ToolError> {
        let w = Wlan::open()?;
        let g = w.interface()?;
        let nets = w.networks(&g)?;
        let connected = nets.iter().find(|n| n.3).map(|n| n.0.clone());
        Ok(json!({
            "connected_to": connected,
            "networks": nets.iter().take(30).map(|n| json!({ "ssid": n.0, "signal_percent": n.1, "secured": n.2, "connected": n.3, "saved": n.4.is_some() })).collect::<Vec<_>>(),
            "note": "Connecting works for networks with a saved profile. New networks that need a password are joined in Settings (system_open_settings page \"wifi\").",
        }))
    }

    pub fn wifi_connect(ssid: &str) -> Result<Value, ToolError> {
        use windows::Win32::NetworkManagement::WiFi::{dot11_BSS_type_any, wlan_connection_mode_profile, WlanConnect, WLAN_CONNECTION_PARAMETERS};
        let w = Wlan::open()?;
        let g = w.interface()?;
        let profile = w
            .networks(&g)?
            .into_iter()
            .find(|n| n.0 == ssid)
            .ok_or_else(|| ToolError::not_found(format!("“{ssid}” isn't in range.")))?
            .4
            .ok_or_else(|| ToolError::new("needs_settings", format!("“{ssid}” has no saved profile. Join it once in Settings (page \"wifi\"), where you can enter its password.")))?;
        let wide: Vec<u16> = profile.encode_utf16().chain(std::iter::once(0)).collect();
        let params = WLAN_CONNECTION_PARAMETERS {
            wlanConnectionMode: wlan_connection_mode_profile,
            strProfile: PCWSTR(wide.as_ptr()),
            pDot11Ssid: std::ptr::null_mut(),
            pDesiredBssidList: std::ptr::null_mut(),
            dot11BssType: dot11_BSS_type_any,
            dwFlags: 0,
        };
        let code = unsafe { WlanConnect(w.0, &g, &params, None) };
        if code != 0 {
            return Err(ToolError::new("system_error", format!("Windows refused to connect (error {code}).")));
        }
        // Verify: wait up to 15 s for the connection.
        for _ in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if w.networks(&g).is_ok_and(|n| n.iter().any(|x| x.0 == ssid && x.3)) {
                return Ok(json!({ "connected_to": ssid, "verified": true, "summary": format!("Connected to {ssid}") }));
            }
        }
        Ok(json!({ "connected_to": null, "verified": false, "summary": format!("Asked to connect to {ssid}, but it isn't connected yet"),
            "note": "The connection wasn't confirmed within 15 seconds. Check system_wifi_status." }))
    }

    pub fn wifi_disconnect() -> Result<Value, ToolError> {
        use windows::Win32::NetworkManagement::WiFi::WlanDisconnect;
        let w = Wlan::open()?;
        let g = w.interface()?;
        let code = unsafe { WlanDisconnect(w.0, &g, None) };
        if code != 0 {
            return Err(ToolError::new("system_error", format!("Windows refused to disconnect (error {code}).")));
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
        let still = w.networks(&g).is_ok_and(|n| n.iter().any(|x| x.3));
        Ok(json!({ "disconnected": !still, "verified": !still, "summary": if still { "Disconnect requested, but Wi-Fi still shows connected" } else { "Wi-Fi disconnected" } }))
    }

    // ---- power ----

    /// Enables SeShutdownPrivilege for this process (needed for sleep/restart/shutdown).
    fn enable_shutdown_privilege() -> Result<(), ToolError> {
        use windows::Win32::Security::{
            AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES,
            TOKEN_PRIVILEGES,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let e = |e: windows::core::Error| ToolError::denied(format!("Windows didn't allow this power action: {e}"));
        unsafe {
            let mut token = windows::Win32::Foundation::HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token).map_err(e)?;
            let mut tp = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: Default::default(), Attributes: SE_PRIVILEGE_ENABLED }] };
            let r = LookupPrivilegeValueW(PCWSTR::null(), w!("SeShutdownPrivilege"), &mut tp.Privileges[0].Luid)
                .and_then(|_| AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None));
            let _ = CloseHandle(token);
            r.map_err(e)
        }
    }

    pub fn power(action: &str) -> Result<String, ToolError> {
        use windows::Win32::Foundation::BOOLEAN;
        use windows::Win32::System::Power::SetSuspendState;
        use windows::Win32::System::Shutdown::{AbortSystemShutdownW, InitiateSystemShutdownExW, SHUTDOWN_REASON};
        // SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_FLAG_PLANNED
        const REASON: SHUTDOWN_REASON = SHUTDOWN_REASON(0x8000_0000);
        let e = |e: windows::core::Error| ToolError::new("system_error", format!("Power action failed: {e}"));
        match action {
            "cancel_shutdown" => {
                enable_shutdown_privilege()?;
                unsafe { AbortSystemShutdownW(PCWSTR::null()) }.map_err(|_| ToolError::not_found("No restart or shutdown is pending."))?;
                Ok("Cancelled the pending restart/shutdown".into())
            }
            "restart" | "shutdown" => {
                enable_shutdown_privilege()?;
                let msg = HSTRING::from(format!("AI Automation: {action} requested by you. Save your work. Cancel with `shutdown /a`."));
                unsafe { InitiateSystemShutdownExW(PCWSTR::null(), &msg, super::SHUTDOWN_DELAY_SECS, false, action == "restart", REASON) }.map_err(e)?;
                Ok(format!("{} scheduled in {} seconds (cancel with system_power cancel_shutdown)", if action == "restart" { "Restart" } else { "Shutdown" }, super::SHUTDOWN_DELAY_SECS))
            }
            "sleep" => {
                enable_shutdown_privilege()?;
                // SetSuspendState only returns after wake-up, so start it shortly after this call returns.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let ok = unsafe { SetSuspendState(BOOLEAN(0), BOOLEAN(0), BOOLEAN(0)) }.as_bool();
                    if !ok {
                        log::warn!("sleep request failed (disabled by policy or hardware?)");
                    }
                });
                Ok("Sleep requested; the computer should sleep in about 2 seconds (not confirmed by Windows beforehand)".into())
            }
            other => Err(ToolError::invalid(format!("Unknown power action `{other}`."))),
        }
    }

    pub fn trigger_state() -> Result<Value, ToolError> {
        let mut names: Vec<String> = processes().into_iter().map(|(_, n)| n.to_lowercase()).collect();
        names.sort();
        names.dedup();
        let mask = unsafe { GetLogicalDrives() };
        let mut free = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let h = HSTRING::from(root.as_str());
            if unsafe { GetDriveTypeW(&h) } != DRIVE_FIXED {
                continue;
            }
            let (mut f, mut t) = (0u64, 0u64);
            if unsafe { GetDiskFreeSpaceExW(&h, None, Some(&mut t), Some(&mut f)) }.is_ok() {
                free.push(json!({ "drive": root, "free_gb": f / 1_073_741_824 }));
            }
        }
        let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let memory_percent = unsafe { GlobalMemoryStatusEx(&mut mem) }.ok().map(|_| mem.dwMemoryLoad);
        Ok(json!({
            "processes": names,
            "battery": battery(),
            "drives": free,
            "memory_percent": memory_percent,
            "online": super::network()["route_to_internet"],
            "locked": session_locked(),
        }))
    }

    /// The input desktop can't be switched to while the session is locked (or on the secure desktop).
    fn session_locked() -> bool {
        use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, SwitchDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_ACCESS_FLAGS};
        unsafe {
            match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100)) {
                Ok(d) => {
                    let locked = SwitchDesktop(d).is_err();
                    let _ = CloseDesktop(d);
                    locked
                }
                Err(_) => true,
            }
        }
    }

    pub fn lock() -> Result<(), ToolError> {
        unsafe { windows::Win32::System::Shutdown::LockWorkStation() }
            .map_err(|e| ToolError::new("system_error", format!("Couldn't lock: {e}")))
    }

    pub fn open_uri(uri: &str) -> Result<(), ToolError> {
        let r = unsafe { ShellExecuteW(HWND(std::ptr::null_mut()), w!("open"), &HSTRING::from(uri), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if (r.0 as isize) <= 32 {
            return Err(ToolError::new("system_error", format!("Windows couldn't open {uri}.")));
        }
        Ok(())
    }

    pub fn status() -> Result<Value, ToolError> {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let b = cpu_times();
        let cpu = match (a, b) {
            (Some((i1, t1)), Some((i2, t2))) if t2 > t1 => 100.0 * (1.0 - (i2 - i1) as f64 / (t2 - t1) as f64),
            _ => -1.0,
        };

        let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let memory = match unsafe { GlobalMemoryStatusEx(&mut mem) } {
            Ok(()) => json!({ "total_mb": mem.ullTotalPhys / 1_048_576, "available_mb": mem.ullAvailPhys / 1_048_576, "used_percent": mem.dwMemoryLoad }),
            Err(_) => json!(null),
        };

        let mask = unsafe { GetLogicalDrives() };
        let mut drives = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let h = HSTRING::from(root.as_str());
            if unsafe { GetDriveTypeW(&h) } != DRIVE_FIXED {
                continue;
            }
            let (mut free, mut total) = (0u64, 0u64);
            if unsafe { GetDiskFreeSpaceExW(&h, None, Some(&mut total), Some(&mut free)) }.is_ok() {
                drives.push(json!({ "drive": root, "total_gb": total / 1_073_741_824, "free_gb": free / 1_073_741_824 }));
            }
        }

        let mut procs: Vec<(u32, String, u64)> =
            processes().into_iter().filter_map(|(pid, name)| working_set(pid).map(|ws| (pid, name, ws))).collect();
        procs.sort_by(|a, b| b.2.cmp(&a.2));
        let top: Vec<Value> = procs
            .iter()
            .take(TOP_PROCESSES)
            .map(|(pid, name, ws)| json!({ "pid": pid, "name": name, "memory_mb": ws / 1_048_576 }))
            .collect();

        Ok(json!({
            "cpu_percent": if cpu >= 0.0 { json!((cpu * 10.0).round() / 10.0) } else { json!(null) },
            "memory": memory,
            "drives": drives,
            "processes_total": procs.len(),
            "top_processes_by_memory": top,
            "battery": battery(),
            "audio": audio(),
            "brightness": "Not read: laptop panel brightness needs WMI, which isn't supported. Use system_open_settings with page \"display\".",
        }))
    }

    /// Validates that `pid` is an ordinary process the user may end. Returns its name.
    pub fn check_endable(pid: u32) -> Result<String, ToolError> {
        if pid <= 4 || pid == std::process::id() {
            return Err(ToolError::denied("That process can't be ended by the assistant."));
        }
        let name = processes()
            .into_iter()
            .find(|(p, _)| *p == pid)
            .map(|(_, n)| n)
            .ok_or_else(|| ToolError::not_found(format!("No process with id {pid} is running.")))?;
        if PROTECTED.contains(&name.to_lowercase().as_str()) {
            return Err(ToolError::denied(format!("{name} is a Windows system process and can't be ended.")));
        }
        match crate::desktop::process_info(pid) {
            Some((_, false)) => Ok(name),
            Some((_, true)) => Err(ToolError::denied(format!("{name} runs as administrator and can't be ended."))),
            None => Err(ToolError::denied(format!("{name} is protected and can't be inspected."))),
        }
    }

    pub fn end(pid: u32) -> Result<String, ToolError> {
        let name = check_endable(pid)?;
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|e| ToolError::denied(format!("Windows refused: {e}")))?;
            let r = TerminateProcess(h, 1);
            let _ = CloseHandle(h);
            r.map_err(|e| ToolError::new("system_error", format!("Couldn't end {name}: {e}")))?;
        }
        Ok(name)
    }
}

/// Cheap state for proactive triggers: running process names, battery, free disk space.
#[tauri::command]
pub async fn trigger_state() -> Result<Value, crate::error::AppError> {
    tauri::async_runtime::spawn_blocking(imp::trigger_state)
        .await
        .map_err(|e| crate::error::AppError::internal(e.to_string()))?
        .map_err(|e| crate::error::AppError::internal(e.message))
}

/// Read-only system snapshot for the Command Center (the user's own request, not a model tool call).
#[tauri::command]
pub async fn system_status_now() -> Result<Value, crate::error::AppError> {
    let v = tauri::async_runtime::spawn_blocking(|| {
        imp::status().map(|mut v| {
            v["network"] = network();
            v
        })
    })
    .await
    .map_err(|e| crate::error::AppError::internal(e.to_string()))?;
    v.map_err(|e| crate::error::AppError::internal(e.message))
}
