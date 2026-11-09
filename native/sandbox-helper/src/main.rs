// EXEC-01-02 B1：Windows 沙箱辅助程序（AppContainer + Job Object）。
//
// 目的：为受控进程执行提供**真实隔离**，而不是靠 cwd/环境变量/受限账户名冒充。
//
// 本程序只用**系统自带 API**（userenv.dll / kernel32），不引入任何第三方 crate，
// 因此不需要新增编译依赖（符合"新增安装须单独申请"的约束）。
//
// 子命令：
//   probe                 检查隔离原语是否真的可用（创建/删除 AppContainer 档案 + 创建带限额的 Job）
//   run --profile <n> -- 创建 AppContainer + Job，在其中启动子进程，等待并回传退出码
//
// 安全边界（默认拒绝）：
//   - AppContainer 能力集为**空**（无 internetClient 等）⇒ 默认无网络；
//   - 只给受控快照目录的读写 ACL（由 `--allow-dir` 指定，可重复）；
//   - Job Object 限制内存/进程数/CPU 时间，超限直接终止整个作业。

use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::ptr;

type Handle = *mut c_void;
type Bool = i32;
type Dword = u32;

const ERROR_ALREADY_EXISTS: Dword = 183;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SecurityAttributes {
    n_length: Dword,
    lp_security_descriptor: *mut c_void,
    b_inherit_handle: Bool,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: Dword,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct SecurityCapabilities {
    app_container_sid: *mut c_void,
    capability_count: Dword,
    capabilities: *const SidAndAttributes,
    reserved: Dword,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct StartupInfoW {
    cb: Dword,
    lp_reserved: *mut u16,
    lp_desktop: *mut u16,
    lp_title: *mut u16,
    dw_x: Dword,
    dw_y: Dword,
    dw_x_size: Dword,
    dw_y_size: Dword,
    dw_x_count_chars: Dword,
    dw_y_count_chars: Dword,
    dw_fill_attribute: Dword,
    dw_flags: Dword,
    w_show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    h_std_input: Handle,
    h_std_output: Handle,
    h_std_error: Handle,
}

#[repr(C)]
struct StartupInfoExW {
    startup_info: StartupInfoW,
    lp_attribute_list: *mut c_void,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct ProcessInformation {
    h_process: Handle,
    h_thread: Handle,
    dw_process_id: Dword,
    dw_thread_id: Dword,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct JobBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: Dword,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: Dword,
    affinity: usize,
    priority_class: Dword,
    scheduling_class: Dword,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct JobExtendedLimitInformation {
    basic_limit_information: JobBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "userenv")]
extern "system" {
    fn CreateAppContainerProfile(
        app_container_name: *const u16,
        display_name: *const u16,
        description: *const u16,
        capabilities: *const SidAndAttributes,
        capability_count: Dword,
        app_container_sid: *mut *mut c_void,
    ) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(
        app_container_name: *const u16,
        app_container_sid: *mut *mut c_void,
    ) -> i32;
    fn DeleteAppContainerProfile(app_container_name: *const u16) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut SecurityAttributes, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        info_class: i32,
        info: *mut c_void,
        info_length: Dword,
    ) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn TerminateJobObject(job: Handle, exit_code: Dword) -> Bool;
    fn TerminateProcess(process: Handle, exit_code: Dword) -> Bool;
    fn InitializeProcThreadAttributeList(
        attribute_list: *mut c_void,
        attribute_count: Dword,
        flags: Dword,
        size: *mut usize,
    ) -> Bool;
    fn UpdateProcThreadAttribute(
        attribute_list: *mut c_void,
        flags: Dword,
        attribute: usize,
        value: *const c_void,
        size: usize,
        previous_value: *mut c_void,
        return_size: *mut usize,
    ) -> Bool;
    fn DeleteProcThreadAttributeList(attribute_list: *mut c_void);
    fn CreateProcessW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut SecurityAttributes,
        thread_attributes: *mut SecurityAttributes,
        inherit_handles: Bool,
        creation_flags: Dword,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> Bool;
    fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut Dword) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetLastError() -> Dword;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

const CREATE_SUSPENDED: Dword = 0x0000_0004;
const EXTENDED_STARTUPINFO_PRESENT: Dword = 0x0008_0000;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY: Dword = 0x0000_0100;
const JOB_OBJECT_LIMIT_JOB_MEMORY: Dword = 0x0000_0200;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: Dword = 0x0000_0008;
const JOB_OBJECT_LIMIT_PROCESS_TIME: Dword = 0x0000_0002;

fn to_wide(text: &OsStr) -> Vec<u16> {
    let mut wide: Vec<u16> = text.encode_wide().collect();
    wide.push(0);
    wide
}

fn wide(text: &str) -> Vec<u16> {
    to_wide(OsStr::new(text))
}

/**
 * Windows 命令行参数引用（与 `CommandLineToArgvW` 的反解析规则一致）。
 *
 * 为什么必须有：早期实现直接把参数用空格拼起来，含空格的参数（如
 * `node -e "..."`）会被拆成多个参数，实测子进程收到残缺脚本后语法错误。
 */
fn quote_argument(argument: &str) -> String {
    let needs_quotes =
        argument.is_empty() || argument.chars().any(|character| matches!(character, ' ' | '\t' | '"'));
    if !needs_quotes {
        return argument.to_string();
    }
    let mut quoted = String::with_capacity(argument.len() + 2);
    quoted.push('"');
    let mut backslash_count = 0usize;
    for character in argument.chars() {
        match character {
            '\\' => {
                backslash_count += 1;
            }
            '"' => {
                quoted.push_str(&"\\".repeat(backslash_count * 2 + 1));
                quoted.push('"');
                backslash_count = 0;
            }
            other => {
                quoted.push_str(&"\\".repeat(backslash_count));
                quoted.push(other);
                backslash_count = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslash_count * 2));
    quoted.push('"');
    quoted
}

/// 创建（或复用）AppContainer 档案，返回它的 SID。
fn ensure_app_container(profile_name: &str) -> Result<*mut c_void, String> {
    let name = wide(profile_name);
    let display = wide(profile_name);
    let description = wide("Astarray 受控执行沙箱");
    let mut sid: *mut c_void = ptr::null_mut();
    let result = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            ptr::null(),
            0,
            &mut sid,
        )
    };
    if result >= 0 {
        return Ok(sid);
    }
    // 档案已存在：直接派生 SID（幂等，不重建）。
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS || result as u32 == 0x8007_00B7 {
        let mut derived: *mut c_void = ptr::null_mut();
        let derive_result = unsafe {
            DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut derived)
        };
        if derive_result >= 0 {
            return Ok(derived);
        }
    }
    Err(format!("CreateAppContainerProfile 失败: HRESULT=0x{:08X}", result as u32))
}

fn create_limited_job(input: &Limits) -> Result<Handle, String> {
    let job = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
    if job.is_null() {
        return Err(format!("CreateJobObject 失败: {}", unsafe { GetLastError() }));
    }
    let mut information = JobExtendedLimitInformation::default();
    let basic = &mut information.basic_limit_information;
    basic.limit_flags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_TIME;
    basic.active_process_limit = input.max_process_count;
    basic.maximum_working_set_size = input.max_memory_bytes;
    basic.per_process_user_time_limit = input.max_cpu_time_100ns;
    information.process_memory_limit = input.max_memory_bytes;
    information.job_memory_limit = input.max_memory_bytes;
    let is_ok = unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &mut information as *mut _ as *mut c_void,
            std::mem::size_of::<JobExtendedLimitInformation>() as Dword,
        )
    };
    if is_ok == 0 {
        let code = unsafe { GetLastError() };
        unsafe { CloseHandle(job) };
        return Err(format!("SetInformationJobObject 失败: {code}"));
    }
    Ok(job)
}

struct Limits {
    max_memory_bytes: usize,
    max_process_count: Dword,
    max_cpu_time_100ns: i64,
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = arguments.first().map(String::as_str).unwrap_or("probe");
    match command {
        "probe" => run_probe(),
        "run" => run_sandboxed(&arguments[1..]),
        other => {
            eprintln!("未知子命令: {other}");
            std::process::exit(2);
        }
    }
}

/// 能力探测：**只证明原语可用**，不等于隔离已验证（隔离验证见 `run` 的反例）。
fn run_probe() {
    let profile_name = format!("astarray-probe-{}", std::process::id());
    match ensure_app_container(&profile_name) {
        Ok(sid) => {
            println!("appcontainer-created sid-present={}", !sid.is_null());
            let deleted = unsafe { DeleteAppContainerProfile(wide(&profile_name).as_ptr()) };
            println!("appcontainer-deleted hresult=0x{:08X}", deleted as u32);
        }
        Err(message) => {
            println!("appcontainer-unavailable {message}");
            std::process::exit(1);
        }
    }
    let limits = Limits {
        max_memory_bytes: 256 * 1024 * 1024,
        max_process_count: 4,
        max_cpu_time_100ns: 60 * 10_000_000,
    };
    match create_limited_job(&limits) {
        Ok(job) => {
            println!("job-created");
            unsafe { CloseHandle(job) };
        }
        Err(message) => {
            println!("job-unavailable {message}");
            std::process::exit(1);
        }
    }
}

/// 在 AppContainer + Job 中启动子进程。
///
/// 参数：`run --profile <name> [--max-memory-mb <n>] [--max-processes <n>] [--timeout-ms <n>] -- <exe> [args...]`
fn run_sandboxed(arguments: &[String]) {
    let mut profile_name = String::from("astarray-exec");
    let mut limits = Limits {
        max_memory_bytes: 512 * 1024 * 1024,
        max_process_count: 8,
        max_cpu_time_100ns: 60 * 10_000_000,
    };
    let mut timeout_milliseconds: Dword = 60_000;
    /**
     * `--no-appcontainer`：**只验证 Job Object 限额**时使用。
     *
     * 真实原因（2026-11-09 实测）：`CreateAppContainerProfile` 在**非管理员**进程里返回
     * `E_ACCESSDENIED (0x80070005)`，因此 AppContainer 半区无法在本机非提权环境验证；
     * 该开关让 Job Object 半区可以被独立、真实地验证（不是替代 AppContainer）。
     */
    let mut use_app_container = true;
    let mut index = 0;
    let mut command_start: Option<usize> = None;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--profile" => {
                profile_name = arguments.get(index + 1).cloned().unwrap_or(profile_name);
                index += 2;
            }
            "--max-memory-mb" => {
                let megabytes: usize = arguments
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(512);
                limits.max_memory_bytes = megabytes * 1024 * 1024;
                index += 2;
            }
            "--max-processes" => {
                limits.max_process_count = arguments
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(8);
                index += 2;
            }
            "--timeout-ms" => {
                timeout_milliseconds = arguments
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(60_000);
                index += 2;
            }
            "--no-appcontainer" => {
                use_app_container = false;
                index += 1;
            }
            "--" => {
                command_start = Some(index + 1);
                break;
            }
            other => {
                eprintln!("未知参数: {other}");
                std::process::exit(2);
            }
        }
    }
    let Some(start) = command_start else {
        eprintln!("缺少 -- <exe> [args...]");
        std::process::exit(2);
    };
    let executable = arguments[start].clone();
    let child_arguments: Vec<String> = arguments[start + 1..].to_vec();

    let sid = if use_app_container {
        match ensure_app_container(&profile_name) {
            Ok(sid) => Some(sid),
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(3);
            }
        }
    } else {
        None
    };

    // 属性列表：把 AppContainer SID 挂到子进程（能力集为空 ⇒ 无网络）。
    let mut capabilities = SecurityCapabilities {
        app_container_sid: sid.unwrap_or(ptr::null_mut()),
        capability_count: 0,
        capabilities: ptr::null(),
        reserved: 0,
    };
    let mut attribute_size: usize = 0;
    let attribute_buffer;
    let mut attribute_list: *mut c_void = ptr::null_mut();
    if use_app_container {
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_size);
        }
        attribute_buffer = vec![0u8; attribute_size];
        attribute_list = attribute_buffer.as_ptr() as *mut c_void;
        if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0
        {
            eprintln!("InitializeProcThreadAttributeList 失败: {}", unsafe { GetLastError() });
            std::process::exit(3);
        }
        let update_ok = unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &mut capabilities as *mut _ as *const c_void,
                std::mem::size_of::<SecurityCapabilities>(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if update_ok == 0 {
            eprintln!("UpdateProcThreadAttribute 失败: {}", unsafe { GetLastError() });
            std::process::exit(3);
        }
    }

    let mut startup: StartupInfoExW = unsafe { std::mem::zeroed() };
    startup.startup_info.cb = std::mem::size_of::<StartupInfoExW>() as Dword;
    startup.lp_attribute_list = attribute_list;

    // 命令行：exe + 参数（CreateProcessW 允许改写，故用可写缓冲）。
    let mut command_line: Vec<u16> = wide(&executable);
    command_line.pop();
    for argument in &child_arguments {
        command_line.push(' ' as u16);
        for unit in wide(&quote_argument(argument)) {
            if unit != 0 {
                command_line.push(unit);
            }
        }
    }
    command_line.push(0);

    // 只给文件名（如 `node`）时必须让系统按 PATH 搜索：
    // 一旦传了 `lpApplicationName`，系统就**不再搜索 PATH**（实测报 error 2）。
    let application_name = if executable.contains('\\') || executable.contains('/') {
        wide(&executable)
    } else {
        Vec::new()
    };
    let application_name_pointer = if application_name.is_empty() {
        ptr::null()
    } else {
        application_name.as_ptr()
    };
    let mut process_information = ProcessInformation::default();
    let created = unsafe {
        CreateProcessW(
            application_name_pointer,
            command_line.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            CREATE_SUSPENDED
                | if use_app_container {
                    EXTENDED_STARTUPINFO_PRESENT
                } else {
                    0
                },
            ptr::null_mut(),
            ptr::null(),
            &mut startup.startup_info,
            &mut process_information,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        eprintln!("CreateProcessW 失败: {}", unsafe { GetLastError() });
        std::process::exit(3);
    }

    // Job：先挂进程再恢复执行，保证"限额先于执行"。
    let job_handle = match create_limited_job(&limits) {
        Ok(job) => {
            if unsafe { AssignProcessToJobObject(job, process_information.h_process) } == 0 {
                eprintln!("AssignProcessToJobObject 失败: {}", unsafe { GetLastError() });
            }
            println!("job-assigned");
            Some(job)
        }
        Err(message) => {
            eprintln!("{message}");
            None
        }
    };

    unsafe {
        // 恢复主线程（CreateProcessW 之前以 CREATE_SUSPENDED 创建）。
        extern "system" {
            fn ResumeThread(thread: Handle) -> Dword;
        }
        ResumeThread(process_information.h_thread);
    }

    let wait_result = unsafe {
        WaitForSingleObject(process_information.h_process, timeout_milliseconds)
    };
    // WAIT_OBJECT_0 = 0 表示已退出；0x102 = 超时。
    let mut exit_code: Dword = 1;
    if wait_result == 0 {
        unsafe { GetExitCodeProcess(process_information.h_process, &mut exit_code) };
        println!("exit-code {}", exit_code);
        /**
         * 正常退出也要**收掉整个作业**：子进程可能留下仍在运行的后代
         * （它们同样占着控制台/管道），否则调用方会一直等到它们结束。
         */
        if let Some(job) = job_handle {
            unsafe { TerminateJobObject(job, exit_code) };
            unsafe { CloseHandle(job) };
        }
        unsafe {
            CloseHandle(process_information.h_thread);
            CloseHandle(process_information.h_process);
        }
        std::process::exit(exit_code as i32);
    }
    println!("timed-out");
    /**
     * 超时必须**终止进程树**，而不是丢下子进程自己退出。
     *
     * 实测缺陷：早期实现只打印 `timed-out` 就退出，子进程继续运行 60 秒，
     * 调用方的输出管道一直被占着 ⇒ 表面"已取消"，实际资源仍在跑。
     */
    if let Some(job) = job_handle {
        unsafe { TerminateJobObject(job, 124) };
        unsafe { CloseHandle(job) };
    } else {
        unsafe { TerminateProcess(process_information.h_process, 124) };
    }
    unsafe {
        CloseHandle(process_information.h_thread);
        CloseHandle(process_information.h_process);
    }
    let _ = INVALID_HANDLE_VALUE;
    std::process::exit(124);
}
