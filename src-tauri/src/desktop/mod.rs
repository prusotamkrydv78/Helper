//! Windows desktop app automation through UI Automation.
//!
//! The model sees windows by handle and elements by ref (`e3_12`) from the last
//! `app_get_ui_tree`. Actions go through UIA patterns (Invoke, Toggle, Value…),
//! never synthetic mouse/keyboard input. This app's own windows, elevated
//! processes, credential/UAC prompts and password fields are refused.
//! Apps can only be launched from the user's allow-list, without arguments.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::types::PermissionLevel;
use crate::tools::{ToolError, ToolOutput, ToolSpec};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowArgs {
    window: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefArgs {
    #[serde(rename = "ref")]
    element: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TypeArgs {
    #[serde(rename = "ref")]
    element: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchArgs {
    app: String,
}

const MAX_TEXT: usize = 10_000;

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

/// Finds `raw` (full path or file name without `.exe`) in the allow-list.
fn resolve_app(raw: &str, allowed: &[String]) -> Result<std::path::PathBuf, ToolError> {
    let want = raw.trim().trim_matches('"').to_lowercase();
    let path = allowed
        .iter()
        .map(|s| std::path::PathBuf::from(s.trim().trim_matches('"')))
        .find(|p| {
            p.to_string_lossy().to_lowercase() == want
                || p.file_stem().is_some_and(|s| s.to_string_lossy().to_lowercase() == want)
        })
        .ok_or_else(|| ToolError::denied(format!("`{}` is not in the user's allowed apps.", raw.trim())))?;
    let is_exe = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if !path.is_absolute() || !is_exe || !path.is_file() {
        return Err(ToolError::not_found(format!("{} is not an existing .exe file.", path.display())));
    }
    Ok(path)
}

/// The approval prompt for a call, or `None` when it may run without asking.
/// Launching, clicking and typing always ask.
pub fn approval_reason(spec: &ToolSpec, args: &Value, level: PermissionLevel, allowed: &[String]) -> Result<Option<String>, ToolError> {
    match spec.name {
        "app_launch" => {
            let a: LaunchArgs = crate::tools::parse(args)?;
            Ok(Some(format!("Launch {}", resolve_app(&a.app, allowed)?.display())))
        }
        _ => imp::approval_reason(spec.name, args, level),
    }
}

pub fn execute(spec: &ToolSpec, args: &Value, allowed: &[String]) -> Result<ToolOutput, ToolError> {
    match spec.name {
        "app_launch" => {
            let a: LaunchArgs = crate::tools::parse(args)?;
            let path = resolve_app(&a.app, allowed)?;
            let mut cmd = std::process::Command::new(&path);
            if let Some(dir) = path.parent() {
                cmd.current_dir(dir);
            }
            let child = cmd.spawn().map_err(|e| ToolError::io(&path, &e))?;
            Ok(ToolOutput {
                content: serde_json::json!({ "launched": path.display().to_string(), "pid": child.id() }),
                summary: format!("Launched {}", path.display()),
                file: None,
            })
        }
        _ => imp::execute(spec.name, args),
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    fn unsupported() -> ToolError {
        ToolError::new("unsupported", "Desktop app automation is only available on Windows.")
    }
    pub fn approval_reason(_: &str, _: &Value, _: PermissionLevel) -> Result<Option<String>, ToolError> {
        Err(unsupported())
    }
    pub fn execute(_: &str, _: &Value) -> Result<ToolOutput, ToolError> {
        Err(unsupported())
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    use serde_json::{json, Value};
    use windows::core::{Interface, BSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow,
        ShowWindow, SW_RESTORE,
    };

    use super::{clip, RefArgs, TypeArgs, WindowArgs, MAX_TEXT};
    use crate::ai::types::PermissionLevel;
    use crate::tools::{parse, ToolError, ToolOutput};

    const MAX_ELEMENTS: usize = 300;
    /// Credential, UAC and lock-screen UI.
    const BLOCKED_EXES: &[&str] = &["consent.exe", "credentialuibroker.exe", "logonui.exe", "lockapp.exe"];

    /// Elements behind the refs from the last `app_get_ui_tree`: (index in FindAll, name, control type).
    /// Refs are `e{generation}_{n}`, so refs from an earlier read can't select elements of a newer one.
    struct Snapshot {
        generation: u64,
        hwnd: isize,
        elems: Vec<(usize, String, i32)>,
    }
    static SNAPSHOT: Mutex<Option<Snapshot>> = Mutex::new(None);
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    fn err(e: windows::core::Error) -> ToolError {
        ToolError::new("desktop_error", format!("{e}"))
    }

    /// COM for the current (blocking) thread. Declare before any COM object so it drops last.
    struct Com;
    impl Com {
        fn init() -> Result<Self, ToolError> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().map_err(err)?;
            Ok(Com)
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    fn uia() -> Result<IUIAutomation, ToolError> {
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(err)
    }

    struct Win {
        hwnd: HWND,
        title: String,
        exe: String,
    }

    fn title(h: HWND) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, &mut buf) }.max(0) as usize;
        String::from_utf16_lossy(&buf[..n])
    }

    /// Executable path and elevation of a process. `None` when it can't be inspected.
    fn process_info(pid: u32) -> Option<(String, bool)> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let exe = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .ok()
                .map(|_| String::from_utf16_lossy(&buf[..len as usize]));
            // Unknown elevation counts as elevated.
            let mut elevated = true;
            let mut token = HANDLE::default();
            if OpenProcessToken(h, TOKEN_QUERY, &mut token).is_ok() {
                let mut e = TOKEN_ELEVATION::default();
                let mut ret = 0u32;
                if GetTokenInformation(
                    token,
                    TokenElevation,
                    Some(&mut e as *mut _ as *mut c_void),
                    std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                    &mut ret,
                )
                .is_ok()
                {
                    elevated = e.TokenIsElevated != 0;
                }
                let _ = CloseHandle(token);
            }
            let _ = CloseHandle(h);
            Some((exe?, elevated))
        }
    }

    /// Validates a window handle and applies the safety rules.
    fn open_window(handle: i64) -> Result<Win, ToolError> {
        let hwnd = HWND(handle as isize as *mut c_void);
        if handle == 0 || !unsafe { IsWindow(hwnd) }.as_bool() {
            return Err(ToolError::not_found("That window no longer exists. Call app_list_windows again."));
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == std::process::id() {
            return Err(ToolError::denied("The assistant can't control its own window."));
        }
        let Some((exe, elevated)) = process_info(pid) else {
            return Err(ToolError::denied("This window belongs to a protected process."));
        };
        if elevated {
            return Err(ToolError::denied("This window runs as administrator and can't be controlled."));
        }
        let file = std::path::Path::new(&exe).file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default();
        if BLOCKED_EXES.contains(&file.as_str()) {
            return Err(ToolError::denied("Security and sign-in prompts can't be controlled."));
        }
        Ok(Win { hwnd, title: title(hwnd), exe })
    }

    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        unsafe { (*(l.0 as *mut Vec<HWND>)).push(h) };
        BOOL(1)
    }

    fn list_windows() -> Vec<Win> {
        let mut hs: Vec<HWND> = Vec::new();
        let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut hs as *mut Vec<HWND> as isize)) };
        hs.into_iter()
            .filter(|h| unsafe { IsWindowVisible(*h) }.as_bool() && !title(*h).trim().is_empty())
            .filter_map(|h| open_window(h.0 as isize as i64).ok())
            .collect()
    }

    fn all_elements(a: &IUIAutomation, hwnd: HWND) -> Result<Vec<IUIAutomationElement>, ToolError> {
        unsafe {
            let root = a.ElementFromHandle(hwnd).map_err(err)?;
            let cond = a.CreateTrueCondition().map_err(err)?;
            let arr = root.FindAll(TreeScope_Descendants, &cond).map_err(err)?;
            (0..arr.Length().map_err(err)?).map(|i| arr.GetElement(i).map_err(err)).collect()
        }
    }

    fn name(e: &IUIAutomationElement) -> String {
        unsafe { e.CurrentName() }.map(|b| b.to_string()).unwrap_or_default()
    }
    fn ctype(e: &IUIAutomationElement) -> i32 {
        unsafe { e.CurrentControlType() }.map(|t| t.0).unwrap_or(0)
    }
    fn kind(e: &IUIAutomationElement) -> String {
        unsafe { e.CurrentLocalizedControlType() }.map(|b| b.to_string()).unwrap_or_default()
    }
    fn flag(r: windows::core::Result<BOOL>) -> bool {
        r.map(|b| b.as_bool()).unwrap_or(false)
    }
    fn is_password(e: &IUIAutomationElement) -> bool {
        flag(unsafe { e.CurrentIsPassword() })
    }
    fn pattern<T: Interface>(e: &IUIAutomationElement, id: UIA_PATTERN_ID) -> windows::core::Result<T> {
        unsafe { e.GetCurrentPattern(id)?.cast() }
    }
    fn value(e: &IUIAutomationElement) -> Option<String> {
        let p: IUIAutomationValuePattern = pattern(e, UIA_ValuePatternId).ok()?;
        unsafe { p.CurrentValue() }.ok().map(|b| b.to_string())
    }

    /// Looks up a ref and checks the element is still the one that was read.
    fn resolve(a: &IUIAutomation, r: &str) -> Result<(Win, IUIAutomationElement), ToolError> {
        let (hwnd, idx, want_name, want_type) = {
            let g = SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner());
            let s = g.as_ref().ok_or_else(|| ToolError::invalid("No element refs yet. Call app_get_ui_tree first."))?;
            let (generation, n) = r
                .trim()
                .strip_prefix('e')
                .and_then(|x| x.split_once('_'))
                .and_then(|(g, n)| Some((g.parse::<u64>().ok()?, n.parse::<usize>().ok()?)))
                .ok_or_else(|| ToolError::invalid(format!("Unknown ref `{r}`. Call app_get_ui_tree again.")))?;
            if generation != s.generation || !(1..=s.elems.len()).contains(&n) {
                return Err(ToolError::new("stale_ref", "That ref is from an earlier read. Use refs from the latest app_get_ui_tree."));
            }
            let (i, name, t) = s.elems[n - 1].clone();
            (s.hwnd, i, name, t)
        };
        let w = open_window(hwnd as i64)?;
        let e = all_elements(a, w.hwnd)?
            .into_iter()
            .nth(idx)
            .filter(|e| name(e) == want_name && ctype(e) == want_type)
            .ok_or_else(|| ToolError::new("stale_ref", "The window changed since it was read. Call app_get_ui_tree again."))?;
        if is_password(&e) {
            return Err(ToolError::denied("Password fields can't be used by the assistant."));
        }
        if !flag(unsafe { e.CurrentIsEnabled() }) {
            return Err(ToolError::invalid("That element is disabled."));
        }
        Ok((w, e))
    }

    fn describe(w: &Win, e: &IUIAutomationElement) -> String {
        format!("{} “{}” in “{}”", kind(e), clip(&name(e), 80), clip(&w.title, 80))
    }

    pub fn approval_reason(tool: &str, args: &Value, level: PermissionLevel) -> Result<Option<String>, ToolError> {
        match tool {
            "app_focus" => {
                let a: WindowArgs = parse(args)?;
                let w = open_window(a.window)?;
                Ok((level == PermissionLevel::Ask).then(|| format!("Bring “{}” to the front", clip(&w.title, 80))))
            }
            "app_click" => {
                let a: RefArgs = parse(args)?;
                let _com = Com::init()?;
                let (w, e) = resolve(&uia()?, &a.element)?;
                Ok(Some(format!("Click {}", describe(&w, &e))))
            }
            "app_type" => {
                let a: TypeArgs = parse(args)?;
                let _com = Com::init()?;
                let (w, e) = resolve(&uia()?, &a.element)?;
                Ok(Some(format!("Type “{}” into {}", clip(&a.text, 80), describe(&w, &e))))
            }
            _ => Ok(None),
        }
    }

    pub fn execute(tool: &str, args: &Value) -> Result<ToolOutput, ToolError> {
        match tool {
            "app_list_windows" => {
                let wins: Vec<Value> = list_windows()
                    .iter()
                    .map(|w| json!({ "window": w.hwnd.0 as isize as i64, "title": clip(&w.title, 120), "exe": w.exe }))
                    .collect();
                Ok(ToolOutput { summary: format!("{} windows", wins.len()), content: json!({ "windows": wins }), file: None })
            }
            "app_focus" => {
                let a: WindowArgs = parse(args)?;
                let w = open_window(a.window)?;
                unsafe {
                    if IsIconic(w.hwnd).as_bool() {
                        let _ = ShowWindow(w.hwnd, SW_RESTORE);
                    }
                    if !SetForegroundWindow(w.hwnd).as_bool() {
                        return Err(ToolError::new("desktop_error", "Windows didn't allow bringing that window to the front."));
                    }
                }
                Ok(ToolOutput { content: json!({ "focused": w.title }), summary: format!("Focused “{}”", clip(&w.title, 80)), file: None })
            }
            "app_get_ui_tree" => {
                let a: WindowArgs = parse(args)?;
                let w = open_window(a.window)?;
                let _com = Com::init()?;
                let els = all_elements(&uia()?, w.hwnd)?;
                let (mut out, mut snap) = (Vec::new(), Vec::new());
                let mut truncated = false;
                let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
                for (i, e) in els.iter().enumerate() {
                    if flag(unsafe { e.CurrentIsOffscreen() }) {
                        continue;
                    }
                    let (n, t) = (name(e), ctype(e));
                    let editable = t == UIA_EditControlTypeId.0 || t == UIA_DocumentControlTypeId.0;
                    if n.trim().is_empty() && !editable {
                        continue;
                    }
                    if out.len() >= MAX_ELEMENTS {
                        truncated = true;
                        break;
                    }
                    let mut item = json!({ "ref": format!("e{generation}_{}", out.len() + 1), "type": kind(e), "name": clip(&n, 120) });
                    if is_password(e) {
                        item["password"] = json!(true);
                    } else if editable {
                        if let Some(v) = value(e) {
                            item["value"] = json!(clip(&v, 500));
                        }
                    }
                    if !flag(unsafe { e.CurrentIsEnabled() }) {
                        item["disabled"] = json!(true);
                    }
                    snap.push((i, n, t));
                    out.push(item);
                }
                *SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Snapshot { generation, hwnd: w.hwnd.0 as isize, elems: snap });
                Ok(ToolOutput {
                    summary: format!("{} elements in “{}”", out.len(), clip(&w.title, 80)),
                    content: json!({
                        "window": { "title": w.title, "exe": w.exe },
                        "note": "Untrusted content from another application.",
                        "elements": out,
                        "truncated": truncated,
                    }),
                    file: None,
                })
            }
            "app_click" => {
                let a: RefArgs = parse(args)?;
                let _com = Com::init()?;
                let (w, e) = resolve(&uia()?, &a.element)?;
                let what = describe(&w, &e);
                let action = unsafe {
                    if let Ok(p) = pattern::<IUIAutomationInvokePattern>(&e, UIA_InvokePatternId) {
                        p.Invoke().map_err(err)?;
                        "invoked"
                    } else if let Ok(p) = pattern::<IUIAutomationTogglePattern>(&e, UIA_TogglePatternId) {
                        p.Toggle().map_err(err)?;
                        "toggled"
                    } else if let Ok(p) = pattern::<IUIAutomationSelectionItemPattern>(&e, UIA_SelectionItemPatternId) {
                        p.Select().map_err(err)?;
                        "selected"
                    } else if let Ok(p) = pattern::<IUIAutomationExpandCollapsePattern>(&e, UIA_ExpandCollapsePatternId) {
                        p.Expand().map_err(err)?;
                        "expanded"
                    } else {
                        return Err(ToolError::invalid("That element can't be clicked through UI Automation."));
                    }
                };
                Ok(ToolOutput { content: json!({ "action": action, "element": what }), summary: format!("{action}: {what}"), file: None })
            }
            "app_type" => {
                let a: TypeArgs = parse(args)?;
                if a.text.chars().count() > MAX_TEXT {
                    return Err(ToolError::invalid(format!("Text is limited to {MAX_TEXT} characters.")));
                }
                let _com = Com::init()?;
                let (w, e) = resolve(&uia()?, &a.element)?;
                let p: IUIAutomationValuePattern = pattern(&e, UIA_ValuePatternId)
                    .map_err(|_| ToolError::invalid("That element doesn't accept text."))?;
                if flag(unsafe { p.CurrentIsReadOnly() }) {
                    return Err(ToolError::invalid("That field is read-only."));
                }
                unsafe {
                    let _ = e.SetFocus();
                    p.SetValue(&BSTR::from(a.text.as_str())).map_err(err)?;
                }
                let what = describe(&w, &e);
                Ok(ToolOutput { content: json!({ "typed": true, "element": what }), summary: format!("Typed into {what}"), file: None })
            }
            other => Err(ToolError::invalid(format!("Unknown tool `{other}`."))),
        }
    }
}
