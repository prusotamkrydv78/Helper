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
struct SettingsArgs {
    page: String,
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
        "system_open_settings" => {
            let a: SettingsArgs = crate::tools::parse(args)?;
            let uri = SETTINGS_PAGES
                .iter()
                .find(|(k, _)| *k == a.page.trim())
                .map(|(_, u)| *u)
                .ok_or_else(|| ToolError::invalid(format!("Unknown settings page. Use one of: {}.", SETTINGS_PAGES.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "))))?;
            imp::open_uri(uri)?;
            Ok(ToolOutput {
                content: serde_json::json!({ "opened": uri, "note": "The Settings window opened; changes there are made by the user or via app_* tools with approval." }),
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
