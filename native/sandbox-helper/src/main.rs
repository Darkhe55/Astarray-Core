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
    /**
     * 2026-11-10 修正：字段顺序必须与 Win32 `SECURITY_CAPABILITIES` 一致：
     * `AppContainerSid, Capabilities(指针), CapabilityCount, Reserved`。
     * 之前把 `capability_count` 放在指针前面 ⇒ 布局错位 ⇒
     * `UpdateProcThreadAttribute` 返回 `ERROR_INVALID_PARAMETER (87)`。
     */
    capabilities: *const SidAndAttributes,
    capability_count: Dword,
    reserved: Dword,
}

/** Low IL 强制标签（TokenIntegrityLevel 的输入缓冲区）。 */
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TokenUser {
    user: SidAndAttributes,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TokenMandatoryLabel {
    label: SidAndAttributes,
}

const DEFAULT_DESIRED_TOKEN_ACCESS: Dword = 0x0001 | 0x0002 | 0x0008 | 0x0080; // ASSIGN_PRIMARY | DUPLICATE | QUERY | ADJUST_DEFAULT
const DISABLE_MAX_PRIVILEGE: Dword = 0x0000_0001;
const SE_GROUP_INTEGRITY: Dword = 0x0000_0020;
const TOKEN_INTEGRITY_LEVEL: Dword = 25;
/** Low 完整性级别 SID（S-1-16-4096）。 */
const LOW_INTEGRITY_SID_STRING: &str = "S-1-16-4096";

/** E3-5（2026-11-25）：命名管道 broker 骨架用到的常量。 */
const TOKEN_QUERY_ACCESS: Dword = 0x0008;
const TOKEN_USER_INFORMATION_CLASS: Dword = 1;
const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
const SDDL_REVISION_1: Dword = 1;
const PIPE_ACCESS_DUPLEX: Dword = 0x0000_0003;
const FILE_FLAG_FIRST_PIPE_INSTANCE: Dword = 0x0008_0000;
const PIPE_TYPE_BYTE: Dword = 0x0000_0000;
const PIPE_READMODE_BYTE: Dword = 0x0000_0000;
const PIPE_WAIT: Dword = 0x0000_0000;
const PIPE_REJECT_REMOTE_CLIENTS: Dword = 0x0000_0008;
const BROKER_MAXIMUM_FRAME_BYTES: usize = 64 * 1024;
/** 仅 SYSTEM 与管道 Owner（当前用户）可访问；远程连接在管道模式层已拒绝。 */
const BROKER_PIPE_SECURITY_DESCRIPTOR: &str = "D:P(A;;GA;;;SY)(A;;GA;;;OW)";
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
    fn GetCurrentProcess() -> Handle;
    fn GetNamedPipeClientProcessId(pipe: Handle, client_process_id: *mut Dword) -> Bool;
    fn CreateNamedPipeW(
        pipe_name: *const u16,
        open_mode: Dword,
        pipe_mode: Dword,
        maximum_instances: Dword,
        outbound_buffer_size: Dword,
        inbound_buffer_size: Dword,
        default_timeout_milliseconds: Dword,
        security_attributes: *mut SecurityAttributes,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> Bool;
    fn DisconnectNamedPipe(pipe: Handle) -> Bool;
    fn FlushFileBuffers(file: Handle) -> Bool;
    fn ReadFile(
        file: Handle,
        buffer: *mut u8,
        bytes_to_read: Dword,
        bytes_read: *mut Dword,
        overlapped: *mut c_void,
    ) -> Bool;
    fn WriteFile(
        file: Handle,
        buffer: *const u8,
        bytes_to_write: Dword,
        bytes_written: *mut Dword,
        overlapped: *mut c_void,
    ) -> Bool;
    fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, desired_access: Dword, token: *mut Handle) -> Bool;
    fn CreateRestrictedToken(
        existing_token: Handle,
        flags: Dword,
        disable_sid_count: Dword,
        sids_to_disable: *const SidAndAttributes,
        delete_privilege_count: Dword,
        privileges_to_delete: *const c_void,
        restricted_sid_count: Dword,
        sids_to_restrict: *const SidAndAttributes,
        new_token: *mut Handle,
    ) -> Bool;
    fn SetTokenInformation(
        token: Handle,
        token_information_class: Dword,
        token_information: *mut c_void,
        token_information_length: Dword,
    ) -> Bool;
    fn CreateProcessAsUserW(
        token: Handle,
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
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut *mut c_void) -> Bool;
    fn GetLengthSid(sid: *mut c_void) -> Dword;
    fn GetTokenInformation(
        token: Handle,
        token_information_class: Dword,
        token_information: *mut c_void,
        token_information_length: Dword,
        return_length: *mut Dword,
    ) -> Bool;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string_security_descriptor: *const u16,
        string_sddl_revision: Dword,
        security_descriptor: *mut *mut c_void,
        security_descriptor_size: *mut Dword,
    ) -> Bool;
}

const CREATE_SUSPENDED: Dword = 0x0000_0004;
const EXTENDED_STARTUPINFO_PRESENT: Dword = 0x0008_0000;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
/**
 * LPAC（Less Privileged AppContainer）：从创建属性里**退出** "ALL APPLICATION PACKAGES"。
 *
 * 2026-11-25 实验：普通用户会话里带 SECURITY_CAPABILITIES 的 CreateProcessW 返回 5；
 * Chrome 的 network service 用 LPAC 在非提权父进程下创建成功，故尝试同一路径。
 * 取值：ProcThreadAttributeValue(27, FALSE, FALSE, FALSE) = 0x0002001B；
 * 值 `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT = 1`。
 */
/** 实测（2026-11-25）：该属性是 ProcThreadAttributeValue(27, FALSE, FALSE, FALSE) = 0x1B，
 *  不带 0x00020000（INPUT）位；写成 0x2001B 会得到 ERROR_GEN_FAILURE(31)。 */
const PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY: usize = 0x0000_001B;
const PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT: Dword = 1;
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
    /**
     * 档案已存在，或**调用者未提权**：都尝试派生 SID。
     *
     * 2026-11-10 实测：档案由提权进程创建后，普通用户调用 `CreateAppContainerProfile`
     * 仍返回 `E_ACCESSDENIED (0x80070005)`（即使档案已存在）。派生 SID
     * （`DeriveAppContainerSidFromAppContainerName`）**不需要提权**，因此这里必须一并回退，
     * 否则"初始化成功"之后普通用户仍无法运行沙箱。
     */
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS
        || result as u32 == 0x8007_00B7
        || result as u32 == 0x8007_0005
    {
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

#[link(name = "advapi32")]
extern "system" {
    fn ConvertSidToStringSidW(sid: *mut c_void, string_sid: *mut *mut u16) -> i32;
}

/**
 * 打印档案的**权威 SID 字符串**（供 `icacls` 复核 ACL 用）。
 *
 * 手算 SID（名称哈希）曾给出无法 Translate 的值，因此必须以系统 API 为准。
 */
fn run_print_sid(arguments: &[String]) {
    let mut profile_name = String::from("astarray-exec");
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == "--profile" {
            profile_name = arguments
                .get(index + 1)
                .cloned()
                .unwrap_or_else(|| profile_name.clone());
            index += 2;
            continue;
        }
        index += 1;
    }
    let name = wide(&profile_name);
    let mut sid: *mut c_void = ptr::null_mut();
    let result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    if result < 0 || sid.is_null() {
        println!("derive-failed hresult=0x{:08X}", result as u32);
        std::process::exit(3);
    }
    let mut string_sid: *mut u16 = ptr::null_mut();
    let converted = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };
    if converted == 0 || string_sid.is_null() {
        println!("convert-failed lastError={}", unsafe { GetLastError() });
        std::process::exit(3);
    }
    let mut length = 0usize;
    unsafe {
        while *string_sid.add(length) != 0 {
            length += 1;
        }
    }
    let slice = unsafe { std::slice::from_raw_parts(string_sid, length) };
    println!("profile={} sid={}", profile_name, String::from_utf16_lossy(slice));
    unsafe { LocalFree(string_sid as *mut c_void) };
}
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = arguments.first().map(String::as_str).unwrap_or("probe");
    match command {
        "probe" => run_probe(),
        "init-sandbox" => run_init_sandbox(&arguments[1..]),
        "run" => run_sandboxed(&arguments[1..]),
        "serve" => run_serve(&arguments[1..]),
        "print-sid" => run_print_sid(&arguments[1..]),
        other => {
            eprintln!("未知子命令: {other}");
            std::process::exit(2);
        }
    }
}

/// 能力探测：**只证明原语可用**，不等于隔离已验证（隔离验证见 `run` 的反例）。
fn run_probe() {
    let profile_name = format!("astarray-probe-{}", std::process::id());
    /**
     * 诊断顺序：先证明**派生**可用（不写任何东西），再试**创建**。
     *
     * 这样能区分两种完全不同的失败：
     *  - 派生也失败 ⇒ 整个 AppContainer API 面被令牌限制；
     *  - 只有创建失败 ⇒ 是"建档案"这一步的权限/环境问题。
     */
    {
        let derived_name = format!("astarray-nonexistent-{}", std::process::id());
        let mut derived_sid: *mut c_void = ptr::null_mut();
        let derive_result = unsafe {
            DeriveAppContainerSidFromAppContainerName(
                wide(&derived_name).as_ptr(),
                &mut derived_sid,
            )
        };
        println!(
            "derive-nonexistent hresult=0x{:08X} lastError={} sid-null={}",
            derive_result as u32,
            unsafe { GetLastError() },
            derived_sid.is_null()
        );
    }
    /**
     * 探测必须区分两种"可用"，否则会**谎报**（2026-11-25 实测）：
     *
     * - `created`：档案是本进程刚建的（需要提权）⇒ 探测完要删除；
     * - `existing`：档案由安装期（提权）预先建好，本进程只是**派生 SID**（运行期非管理员）
     *   ⇒ **绝不删除**（那是安装期资产，删了会让后续运行不可用）。
     *
     * 旧实现把"创建失败但派生成功"也打印成 `appcontainer-created`，且删除失败仍以 0 退出，
     * 导致上层把"根本没有档案、也建不了"误判为可用。
     */
    let name = wide(&profile_name);
    let display = wide(&profile_name);
    let description = wide("Astarray 受控执行沙箱");
    let mut sid: *mut c_void = ptr::null_mut();
    let create_result = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            ptr::null(),
            0,
            &mut sid,
        )
    };
    if create_result >= 0 {
        println!("appcontainer-created sid-present={}", !sid.is_null());
        let mut deleted = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        let mut delete_attempts: u32 = 1;
        while deleted != 0 && delete_attempts < 8 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            deleted = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
            delete_attempts += 1;
        }
        println!(
            "appcontainer-deleted hresult=0x{:08X} attempts={}",
            deleted as u32, delete_attempts
        );
    } else {
        /** 已存在（ERROR_ALREADY_EXISTS）或非管理员（E_ACCESSDENIED）⇒ 派生 SID。 */
        let mut derived: *mut c_void = ptr::null_mut();
        let derive_result =
            unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut derived) };
        if derive_result >= 0 && !derived.is_null() {
            println!("appcontainer-existing sid-present=true");
        } else {
            println!(
                "appcontainer-unavailable CreateAppContainerProfile HRESULT=0x{:08X}，派生 SID 失败 HRESULT=0x{:08X}（非管理员且未做安装期初始化）",
                create_result as u32, derive_result as u32
            );
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

/// 安装期**一次性**初始化：为**当前用户**创建 AppContainer 档案。
///
/// 用户裁决（2026-11-09）的约束逐条落在这里：
///  - **明确确认**：没有 `--confirm-create-profile` 一律拒绝（不静默建档案）；
///  - **每用户档案**：只给当前用户建（`CreateAppContainerProfile` 语义即 per-user per-app）；
///  - **客户端整体不提权**：本子命令是唯一需要提权的入口，运行期只用 `Derive...`。
fn run_init_sandbox(arguments: &[String]) {
    let mut profile_name = String::from("astarray-exec");
    let mut has_confirmation = false;
    let mut recreate_profile = false;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--confirm-create-profile" => {
                has_confirmation = true;
                index += 1;
            }
            "--profile" => {
                profile_name = arguments.get(index + 1).cloned().unwrap_or(profile_name);
                index += 2;
            }
            /** 安装期重建：先删掉**陈旧档案**再建（仅显式确认时使用）。 */
            "--recreate" => {
                recreate_profile = true;
                index += 1;
            }
            other => {
                eprintln!("未知参数: {other}");
                std::process::exit(2);
            }
        }
    }
    if !has_confirmation {
        eprintln!(
            "拒绝执行：创建沙箱档案需要显式确认。请加 --confirm-create-profile 重试。"
        );
        eprintln!("说明：本步骤只需在安装期执行一次，运行期不需要管理员权限。");
        std::process::exit(2);
    }
    /**
     * 陈旧档案：注册表里有、但 `%LOCALAPPDATA%\Packages\<profile>\Temp` 已被删掉。
     * 这种档案**能派生 SID 却不能跑进程**（cwd 不可用 ⇒ CreateProcessW 错误 5）。
     * 安装期允许显式 `--recreate` 重建它。
     */
    if recreate_profile {
        let deleted = unsafe { DeleteAppContainerProfile(wide(&profile_name).as_ptr()) };
        println!("profile-recreate-delete hresult=0x{:08X}", deleted as u32);
    }
    match ensure_app_container(&profile_name) {
        Ok(sid) => {
            if sid.is_null() {
                eprintln!("创建档案返回了空 SID：视为失败（不声称成功）");
                std::process::exit(3);
            }
            /**
             * 创建后立刻验证**派生**可用 —— 运行期只走派生路径，
             * 因此"派生失败"等于初始化白做。
             */
            let mut derived: *mut c_void = ptr::null_mut();
            let derive_result = unsafe {
                DeriveAppContainerSidFromAppContainerName(
                    wide(&profile_name).as_ptr(),
                    &mut derived,
                )
            };
            if derive_result < 0 || derived.is_null() {
                eprintln!(
                    "档案已创建，但派生 SID 失败：HRESULT=0x{:08X}",
                    derive_result as u32
                );
                std::process::exit(4);
            }
            println!("profile-created name={profile_name}");
            println!("derive-ok");
        }
        Err(message) => {
            eprintln!("{message}");
            eprintln!(
                "提示：若报 HRESULT=0x80070005，说明当前进程没有创建档案的权限；\
                 请以管理员身份**仅**运行本初始化步骤，运行期仍以标准用户运行。"
            );
            std::process::exit(3);
        }
    }
}

/// 在 AppContainer + Job 中启动子进程。
///
/// 参数：`run --profile <name> [--max-memory-mb <n>] [--max-processes <n>] [--timeout-ms <n>] -- <exe> [args...]`
/**
 * E1 弱档（2026-11-25）：**不提权**的受限令牌 + Low 完整性级别。
 *
 * 语义（必须如实标注）：
 * - 写入：Low IL 的 no-write-up ⇒ 对中等完整性对象（用户目录、仓库）**写被拒**；
 * - 读取：**不设防**（Low IL 不阻止读）⇒ 这不是读隔离，产品文案不得宣称；
 * - 网络：未在令牌层阻断（需要 WFP/AppContainer capability）⇒ 由环境级离线控制兜底。
 *
 * 与 AppContainer 的关系：不创建/不依赖档案；用于强档不可用时（普通用户会话）。
 */
unsafe fn create_low_integrity_process(
    application_name: *const u16,
    command_line: *mut u16,
    current_directory: *const u16,
    startup_info: *mut StartupInfoW,
    process_information: *mut ProcessInformation,
) -> Result<(), String> {
    let mut current_token: Handle = ptr::null_mut();
    if OpenProcessToken(
        GetCurrentProcess(),
        DEFAULT_DESIRED_TOKEN_ACCESS,
        &mut current_token,
    ) == 0
    {
        return Err(format!("OpenProcessToken 失败: {}", GetLastError()));
    }
    let mut restricted_token: Handle = ptr::null_mut();
    if CreateRestrictedToken(
        current_token,
        DISABLE_MAX_PRIVILEGE,
        0,
        ptr::null(),
        0,
        ptr::null(),
        0,
        ptr::null(),
        &mut restricted_token,
    ) == 0
    {
        CloseHandle(current_token);
        return Err(format!("CreateRestrictedToken 失败: {}", GetLastError()));
    }
    CloseHandle(current_token);

    let sid_string = wide(LOW_INTEGRITY_SID_STRING);
    let mut low_integrity_sid: *mut c_void = ptr::null_mut();
    if ConvertStringSidToSidW(sid_string.as_ptr(), &mut low_integrity_sid) == 0 {
        CloseHandle(restricted_token);
        return Err(format!("ConvertStringSidToSidW 失败: {}", GetLastError()));
    }
    let mut mandatory_label = TokenMandatoryLabel {
        label: SidAndAttributes {
            sid: low_integrity_sid,
            attributes: SE_GROUP_INTEGRITY,
        },
    };
    let label_size =
        std::mem::size_of::<TokenMandatoryLabel>() as Dword + GetLengthSid(low_integrity_sid);
    if SetTokenInformation(
        restricted_token,
        TOKEN_INTEGRITY_LEVEL,
        &mut mandatory_label as *mut _ as *mut c_void,
        label_size,
    ) == 0
    {
        let error = GetLastError();
        LocalFree(low_integrity_sid);
        CloseHandle(restricted_token);
        return Err(format!("SetTokenInformation(TokenIntegrityLevel) 失败: {error}"));
    }
    LocalFree(low_integrity_sid);

    let created = CreateProcessAsUserW(
        restricted_token,
        application_name,
        command_line,
        ptr::null_mut(),
        ptr::null_mut(),
        0,
        CREATE_SUSPENDED,
        ptr::null_mut(),
        current_directory,
        startup_info,
        process_information,
    );
    CloseHandle(restricted_token);
    if created == 0 {
        return Err(format!("CreateProcessAsUserW 失败: {}", GetLastError()));
    }
    Ok(())
}
// ----- E3-5（2026-11-25）：命名管道 broker 骨架 -----

unsafe fn token_user_sid_string(token: Handle) -> Result<String, String> {
    let mut needed: Dword = 0;
    GetTokenInformation(
        token,
        TOKEN_USER_INFORMATION_CLASS,
        ptr::null_mut(),
        0,
        &mut needed,
    );
    if needed == 0 {
        return Err(format!("GetTokenInformation(尺寸) 失败: {}", GetLastError()));
    }
    let mut buffer = vec![0u8; needed as usize];
    if GetTokenInformation(
        token,
        TOKEN_USER_INFORMATION_CLASS,
        buffer.as_mut_ptr() as *mut c_void,
        needed,
        &mut needed,
    ) == 0
    {
        return Err(format!("GetTokenInformation 失败: {}", GetLastError()));
    }
    let token_user = &*(buffer.as_ptr() as *const TokenUser);
    let mut sid_string: *mut u16 = ptr::null_mut();
    if ConvertSidToStringSidW(token_user.user.sid, &mut sid_string) == 0 {
        return Err(format!("ConvertSidToStringSidW 失败: {}", GetLastError()));
    }
    let mut length = 0usize;
    while *sid_string.add(length) != 0 {
        length += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, length));
    LocalFree(sid_string as *mut c_void);
    Ok(text)
}

unsafe fn current_user_sid_string() -> Result<String, String> {
    let mut token: Handle = ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY_ACCESS, &mut token) == 0 {
        return Err(format!("OpenProcessToken 失败: {}", GetLastError()));
    }
    let result = token_user_sid_string(token);
    CloseHandle(token);
    result
}

unsafe fn client_user_sid_string(pipe: Handle) -> Result<String, String> {
    let mut process_id: Dword = 0;
    if GetNamedPipeClientProcessId(pipe, &mut process_id) == 0 {
        return Err(format!("GetNamedPipeClientProcessId 失败: {}", GetLastError()));
    }
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
    if process.is_null() {
        return Err(format!("OpenProcess(客户端 {process_id}) 失败: {}", GetLastError()));
    }
    let mut token: Handle = ptr::null_mut();
    if OpenProcessToken(process, TOKEN_QUERY_ACCESS, &mut token) == 0 {
        let error = GetLastError();
        CloseHandle(process);
        return Err(format!("OpenProcessToken(客户端) 失败: {error}"));
    }
    let result = token_user_sid_string(token);
    CloseHandle(token);
    CloseHandle(process);
    result
}

fn read_pipe_frame(pipe: Handle) -> Result<Option<String>, String> {
    let mut frame: Vec<u8> = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let mut bytes_read: Dword = 0;
        let ok = unsafe { ReadFile(pipe, byte.as_mut_ptr(), 1, &mut bytes_read, ptr::null_mut()) };
        if ok == 0 || bytes_read == 0 {
            return Ok(None);
        }
        if byte[0] == b'\n' {
            return Ok(Some(String::from_utf8_lossy(&frame).to_string()));
        }
        frame.push(byte[0]);
        if frame.len() > BROKER_MAXIMUM_FRAME_BYTES {
            return Err(format!("frame-too-large：超过 {} 字节", BROKER_MAXIMUM_FRAME_BYTES));
        }
    }
}

fn write_pipe_text(pipe: Handle, text: &str) -> Result<(), String> {
    let bytes = text.as_bytes();
    let mut bytes_written: Dword = 0;
    let ok = unsafe {
        WriteFile(
            pipe,
            bytes.as_ptr(),
            bytes.len() as Dword,
            &mut bytes_written,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!("WriteFile 失败: {}", unsafe { GetLastError() }));
    }
    if bytes_written as usize != bytes.len() {
        return Err("WriteFile 未写全".to_string());
    }
    /** 断开管道前必须 flush，否则客户端可能读不到刚写出的响应（实测超大帧响应丢失）。 */
    unsafe { FlushFileBuffers(pipe) };
    Ok(())
}

fn extract_request_identifier(frame: &str) -> Option<String> {
    let marker = "\"requestIdentifier\"";
    let index = frame.find(marker)?;
    let rest = frame[index + marker.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.trim().is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn safe_identifier(value: &str) -> String {
    let filtered: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_')
        .collect();
    if filtered.is_empty() {
        "unknown".to_string()
    } else {
        filtered
    }
}

fn broker_response(request_identifier: &str, outcome: &str, reason_code: Option<&str>) -> String {
    let identifier = safe_identifier(request_identifier);
    match reason_code {
        None => format!(
            "{{\"schemaVersion\":1,\"requestIdentifier\":\"{identifier}\",\"payload\":{{\"outcome\":\"{outcome}\"}}}}\n"
        ),
        Some(code) => format!(
            "{{\"schemaVersion\":1,\"requestIdentifier\":\"{identifier}\",\"payload\":{{\"outcome\":\"{outcome}\",\"reasonCode\":\"{code}\"}}}}\n"
        ),
    }
}

/**
 * E3-5 最小骨架（**不执行任何进程**，只验证传输与身份）：
 * - 管道 ACL 仅 SYSTEM + Owner；`PIPE_REJECT_REMOTE_CLIENTS` 拒远程；
 * - 连接后校验客户端进程的 TokenUser SID == 本进程 SID，不匹配即拒绝；
 * - 只支持 `ping` → `pong`，其余请求如实返回 `rejected/unknown-request`；
 * - 帧上限 64 KiB，超限回 `rejected/frame-too-large`。
 *
 * 真正的"模拟调用方 + AppContainer 建进程"留给管理员会话下的 E3-6；在此之前
 * 不得把本骨架当作强档可用。
 */
// ----- E3-6（2026-11-25）：serve 的执行路径（显式开关，强档优先、弱档需显式） -----

#[derive(Default, Clone)]
struct ServeExecutionOptions {
    allow_weak_execution: bool,
    allow_strong_execution: bool,
}

fn parse_json_string_with_length(input: &str) -> Option<(String, usize)> {
    let mut output = String::new();
    let mut characters = input.char_indices();
    while let Some((index, character)) = characters.next() {
        match character {
            '"' => return Some((output, index + 1)),
            '\\' => match characters.next()?.1 {
                'n' => output.push('\n'),
                't' => output.push('\t'),
                'r' => output.push('\r'),
                '"' => output.push('"'),
                '\\' => output.push('\\'),
                _ => return None,
            },
            value if (value as u32) < 0x20 => return None,
            value => output.push(value),
        }
    }
    None
}

fn extract_json_string(frame: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\"");
    let index = frame.find(&marker)?;
    let rest = frame[index + marker.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    parse_json_string_with_length(rest).map(|(value, _length)| value)
}

fn extract_json_number(frame: &str, key: &str) -> Option<u64> {
    let marker = format!("\"{key}\"");
    let index = frame.find(&marker)?;
    let rest = frame[index + marker.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(|character| character.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

fn extract_json_string_array(frame: &str, key: &str) -> Option<Vec<String>> {
    let marker = format!("\"{key}\"");
    let index = frame.find(&marker)?;
    let rest = frame[index + marker.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('[')?;
    let mut values: Vec<String> = Vec::new();
    let mut cursor = rest.trim_start();
    if let Some(after_empty) = cursor.strip_prefix(']') {
        let _ = after_empty;
        return Some(values);
    }
    loop {
        cursor = cursor.trim_start();
        let cursor_without_quote = cursor.strip_prefix('"')?;
        let (value, raw_length) = parse_json_string_with_length(cursor_without_quote)?;
        values.push(value);
        /** 用**源文本**长度推进游标（value 已去转义，长度会短于源）。 */
        let consumed = 1 + raw_length;
        cursor = cursor[consumed..].trim_start();
        if let Some(after_comma) = cursor.strip_prefix(',') {
            cursor = after_comma;
            continue;
        }
        cursor.strip_prefix(']')?;
        return Some(values);
    }
}

fn json_escape(text: &str) -> String {
    let mut output = String::new();
    for character in text.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if (value as u32) < 0x20 => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output
}

fn truncate_for_response(text: &str) -> (String, bool) {
    const LIMIT: usize = 8 * 1024;
    if text.len() <= LIMIT {
        return (text.to_string(), false);
    }
    let mut end = LIMIT;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn execute_broker_request(frame: &str, options: &ServeExecutionOptions) -> String {
    let request_identifier = extract_json_string(frame, "requestIdentifier").unwrap_or_else(|| "unknown".to_string());
    let identifier = safe_identifier(&request_identifier);
    let reject = |reason: &str| {
        format!(
            "{{\"schemaVersion\":1,\"requestIdentifier\":\"{identifier}\",\"payload\":{{\"outcome\":\"rejected\",\"reasonCode\":\"{reason}\"}}}}\n"
        )
    };
    if !options.allow_weak_execution && !options.allow_strong_execution {
        return reject("execution-disabled");
    }
    let executable_path = extract_json_string(frame, "executablePath").unwrap_or_default();
    let working_directory = extract_json_string(frame, "workingDirectory").unwrap_or_default();
    let arguments = extract_json_string_array(frame, "arguments").unwrap_or_default();
    let timeout_milliseconds = extract_json_number(frame, "timeoutMilliseconds").unwrap_or(0);
    let maximum_memory_bytes = extract_json_number(frame, "maximumMemoryBytes").unwrap_or(0);
    let maximum_process_count = extract_json_number(frame, "maximumProcessCount").unwrap_or(0);

    let is_absolute = |value: &str| {
        let bytes = value.as_bytes();
        (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
            || value.starts_with("\\\\")
    };
    if !is_absolute(&executable_path) || !std::path::Path::new(&executable_path).is_file() {
        return reject("executable-not-allowed");
    }
    if !is_absolute(&working_directory) || !std::path::Path::new(&working_directory).is_dir() {
        return reject("working-directory-not-allowed");
    }
    if timeout_milliseconds == 0 || timeout_milliseconds > 600_000 {
        return reject("timeout-exceeded");
    }
    if maximum_memory_bytes == 0 || maximum_memory_bytes > 8 * 1024 * 1024 * 1024 {
        return reject("resource-limit-exceeded");
    }
    if maximum_process_count == 0 || maximum_process_count > 64 {
        return reject("resource-limit-exceeded");
    }

    let current_executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("current_exe 失败: {error}");
            return reject("internal-error");
        }
    };
    let mut command = std::process::Command::new(current_executable);
    command.arg("run");
    if options.allow_strong_execution {
        command.args(["--profile", "astarray-broker-strong"]);
    } else {
        command.args(["--low-integrity", "--work-dir", &working_directory]);
    }
    command.args([
        "--timeout-ms",
        &timeout_milliseconds.to_string(),
        "--max-memory-mb",
        &(maximum_memory_bytes / (1024 * 1024)).max(1).to_string(),
        "--max-processes",
        &maximum_process_count.to_string(),
        "--",
        &executable_path,
    ]);
    command.args(&arguments);
    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            eprintln!("执行失败: {error}");
            return reject("internal-error");
        }
    };
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
    /**
     * E3-7（2026-11-25）：强档建进程失败（非管理员会话）必须**如实拒绝**，
     * 不得把 helper 的"CreateProcessW 失败"当成 executed 回传，更不能回退弱档。
     * helper 用退出码 3 表示"建进程失败"（见 run_sandboxed）。
     */
    if options.allow_strong_execution && output.status.code() == Some(3) {
        let (detail_value, _detail_truncated) = truncate_for_response(&stderr_text);
        let mut response = String::new();
        response.push_str("{\"schemaVersion\":1,\"requestIdentifier\":\"");
        response.push_str(&identifier);
        response.push_str("\",\"payload\":{\"outcome\":\"rejected\",\"reasonCode\":\"strong-tier-unavailable\",\"detail\":\"");
        response.push_str(&json_escape(&detail_value));
        response.push_str("\"}}\n");
        return response;
    }
    let timed_out = stdout_text.contains("timed-out");
    let exit_code = stdout_text
        .lines()
        .find_map(|line| line.strip_prefix("exit-code "))
        .and_then(|value| value.trim().parse::<i32>().ok())
        .or(output.status.code())
        .unwrap_or(1);
    let (stdout_value, stdout_truncated) = truncate_for_response(&stdout_text);
    let (stderr_value, stderr_truncated) = truncate_for_response(&stderr_text);
    /** 显式拼接，避免 format! 里大量花括号导致的 off-by-one（实测多出一个 `}` 使客户端解析失败）。 */
    let mut response = String::new();
    response.push_str("{\"schemaVersion\":1,\"requestIdentifier\":\"");
    response.push_str(&identifier);
    response.push_str("\",\"payload\":{\"outcome\":\"executed\",\"exitCode\":");
    response.push_str(&exit_code.to_string());
    response.push_str(",\"timedOut\":");
    response.push_str(if timed_out { "true" } else { "false" });
    response.push_str(",\"stdout\":\"");
    response.push_str(&json_escape(&stdout_value));
    response.push_str("\",\"stderr\":\"");
    response.push_str(&json_escape(&stderr_value));
    response.push_str("\",\"truncated\":");
    response.push_str(if stdout_truncated || stderr_truncated {
        "true"
    } else {
        "false"
    });
    response.push_str("}}\n");
    response
}
fn run_serve(arguments: &[String]) {
    let pipe_name = arguments
        .iter()
        .position(|argument| argument == "--pipe-name")
        .and_then(|index| arguments.get(index + 1))
        .cloned()
        .unwrap_or_default();
    if pipe_name.is_empty() {
        eprintln!("serve 需要 --pipe-name <\\\\\\\\.\\\\pipe\\\\...>");
        std::process::exit(2);
    }
    let options = ServeExecutionOptions {
        allow_weak_execution: arguments.iter().any(|argument| argument == "--allow-weak-execution"),
        allow_strong_execution: arguments.iter().any(|argument| argument == "--allow-strong-execution"),
    };
    let own_sid = match unsafe { current_user_sid_string() } {
        Ok(sid) => sid,
        Err(message) => {
            eprintln!("读取当前用户 SID 失败: {message}");
            std::process::exit(3);
        }
    };
    let sddl = wide(BROKER_PIPE_SECURITY_DESCRIPTOR);
    let mut security_descriptor: *mut c_void = ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut security_descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 {
        eprintln!("SecurityDescriptor(SDDL) 转换失败: {}", unsafe { GetLastError() });
        std::process::exit(3);
    }
    let mut security_attributes = SecurityAttributes {
        n_length: std::mem::size_of::<SecurityAttributes>() as Dword,
        lp_security_descriptor: security_descriptor,
        b_inherit_handle: 0,
    };
    let pipe_name_wide = wide(&pipe_name);
    let pipe = unsafe {
        CreateNamedPipeW(
            pipe_name_wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            BROKER_MAXIMUM_FRAME_BYTES as Dword,
            BROKER_MAXIMUM_FRAME_BYTES as Dword,
            0,
            &mut security_attributes,
        )
    };
    unsafe { LocalFree(security_descriptor) };
    if pipe == INVALID_HANDLE_VALUE {
        eprintln!("CreateNamedPipeW 失败: {}", unsafe { GetLastError() });
        std::process::exit(3);
    }
    println!("broker-ready {pipe_name}");
    let mut seen_requests: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        let connected = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) };
        let connect_error = if connected == 0 { unsafe { GetLastError() } } else { 0 };
        /** ERROR_PIPE_CONNECTED(535) 表示客户端已先连上，属于正常。 */
        if connected == 0 && connect_error != 535 {
            eprintln!("ConnectNamedPipe 失败: {connect_error}");
            std::process::exit(4);
        }
        let client_sid = unsafe { client_user_sid_string(pipe) };
        match client_sid {
            Ok(sid) if sid == own_sid => {}
            Ok(_) => {
                let _ = write_pipe_text(
                    pipe,
                    &broker_response("unknown", "rejected", Some("caller-sid-mismatch")),
                );
                unsafe {
                    DisconnectNamedPipe(pipe);
                }
                continue;
            }
            Err(message) => {
                eprintln!("无法识别客户端身份，拒绝连接: {message}");
                unsafe {
                    DisconnectNamedPipe(pipe);
                }
                continue;
            }
        }
        loop {
            match read_pipe_frame(pipe) {
                Ok(Some(frame)) => {
                    let identifier =
                        extract_request_identifier(&frame).unwrap_or_else(|| "unknown".to_string());
                    /** 按 payload.type 判定，而不是"帧里出现 ping 字样"——参数里可能包含 ping。 */
                    let payload_type = extract_json_string(&frame, "type").unwrap_or_default();
                    let response = if payload_type == "ping" {
                        broker_response(&identifier, "pong", None)
                    } else if payload_type == "execute" {
                        if !seen_requests.insert(identifier.clone()) {
                            broker_response(&identifier, "rejected", Some("duplicate-request"))
                        } else {
                            execute_broker_request(&frame, &options)
                        }
                    } else {
                        broker_response(&identifier, "rejected", Some("unknown-request"))
                    };
                    if let Err(message) = write_pipe_text(pipe, &response) {
                        eprintln!("写响应失败: {message}");
                        break;
                    }
                }
                Ok(None) => break,
                Err(message) => {
                    let _ = write_pipe_text(
                        pipe,
                        &broker_response("unknown", "rejected", Some("frame-too-large")),
                    );
                    eprintln!("{message}");
                    break;
                }
            }
        }
        unsafe {
            DisconnectNamedPipe(pipe);
        }
    }
}
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
    let mut use_lpac = false;
    /** E1 弱档：受限令牌 + Low IL（不提权）；与 AppContainer 互斥。 */
    let mut use_low_integrity = false;
    /** 弱档可指定工作目录（强档由档案 Temp 决定；弱档不强制改写用户目录）。 */
    let mut requested_work_directory: Option<String> = None;
    /** 诊断开关：传空属性列表（仍带 EXTENDED_STARTUPINFO），用于隔离"属性内容"与"标志本身"。 */
    let mut isEmptyAttributes = false;
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
            "--empty-attributes" => {
                isEmptyAttributes = true;
                index += 1;
            }
            "--low-integrity" => {
                use_low_integrity = true;
                use_app_container = false;
                index += 1;
            }
            "--work-dir" => {
                requested_work_directory = arguments.get(index + 1).cloned();
                index += 2;
            }
            "--lpac" => {
                use_lpac = true;
                index += 1;
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
            InitializeProcThreadAttributeList(
                ptr::null_mut(),
                if isEmptyAttributes { 0 } else if use_lpac { 2 } else { 1 },
                0,
                &mut attribute_size,
            );
        }
        // 用 `usize` 分配：属性列表要求指针对齐（`Vec<u8>` 只有 1 字节对齐）。
        attribute_buffer = vec![0usize; (attribute_size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        attribute_list = attribute_buffer.as_ptr() as *mut c_void;
        if unsafe {
            InitializeProcThreadAttributeList(
                attribute_list,
                if isEmptyAttributes { 0 } else if use_lpac { 2 } else { 1 },
                0,
                &mut attribute_size,
            )
        } == 0
        {
            eprintln!("InitializeProcThreadAttributeList 失败: {}", unsafe { GetLastError() });
            std::process::exit(3);
        }
        let update_ok = if isEmptyAttributes {
            1
        } else {
            unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &mut capabilities as *mut _ as *const c_void,
                std::mem::size_of::<SecurityCapabilities>(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
            }
        };
        if update_ok == 0 {
            eprintln!("UpdateProcThreadAttribute 失败: {}", unsafe { GetLastError() });
            std::process::exit(3);
        }
        if use_lpac {
            let mut all_application_packages_policy: Dword =
                PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
            let lpac_ok = unsafe {
                UpdateProcThreadAttribute(
                    attribute_list,
                    0,
                    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
                    &mut all_application_packages_policy as *mut _ as *const c_void,
                    std::mem::size_of::<Dword>(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if lpac_ok == 0 {
                eprintln!("UpdateProcThreadAttribute(LPAC) 失败: {}", unsafe { GetLastError() });
                std::process::exit(3);
            }
        }
    }

    /**
     * 容器内可写、且容器有权访问的工作目录：
     * `%LOCALAPPDATA%\Packages\<profile>\Temp`（档案创建时由系统建好）。
     * 取不到时退回 `C:\Windows\Temp`（对 AppContainer 只读但可进入）。
     */
    /**
     * 容器内可写的工作目录（2026-11-25 修正）：
     *
     * AppContainer 档案的实际布局是 `%LOCALAPPDATA%\Packages\<profile>\AC`（OS 创建时带
     * AppContainer SID 的 ACL），可写临时目录在其下的 `AC\Temp`。
     *
     * 旧实现找 `...\<profile>\Temp`（不存在）⇒ 回退 `C:\Windows\Temp`（容器无权进入）
     * ⇒ `CreateProcessW` 恒返回 **5 (ACCESS_DENIED)**。这里改为优先 `AC\Temp`，并**主动创建**。
     */
    let working_directory: Vec<u16> = if use_low_integrity {
        /** 弱档：Low IL 可读用户临时目录；写入会被 no-write-up 拒绝（正好用于验收）。 */
        wide(
            requested_work_directory
                .as_deref()
                .unwrap_or(&std::env::temp_dir().to_string_lossy()),
        )
    } else {
        let base = std::env::var("LOCALAPPDATA").ok();
        let mut chosen: Option<String> = None;
        if let Some(base_path) = base.as_deref() {
            for candidate in [
                format!("{base_path}\\Packages\\{profile_name}\\AC\\Temp"),
                format!("{base_path}\\Packages\\{profile_name}\\Temp"),
            ] {
                if std::path::Path::new(&candidate).is_dir() {
                    chosen = Some(candidate);
                    break;
                }
                if std::fs::create_dir_all(&candidate).is_ok() {
                    chosen = Some(candidate);
                    break;
                }
            }
        }
        match chosen {
            Some(path) => wide(&path),
            None => wide("C:\\Windows\\Temp"),
        }
    };
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
    let mut created: Bool = 0;
    if use_low_integrity {
        let spawn_result = unsafe {
            create_low_integrity_process(
                application_name_pointer,
                command_line.as_mut_ptr(),
                working_directory.as_ptr(),
                &mut startup.startup_info,
                &mut process_information,
            )
        };
        if let Err(message) = spawn_result {
            eprintln!("{message}");
            std::process::exit(3);
        }
        created = 1;
    } else {
    unsafe {
        created = CreateProcessW(
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
            /**
             * 2026-11-10 修正：工作目录必须显式给出**容器可访问**的路径。
             * 传 null ⇒ 子进程继承父进程当前目录（用户工作区），
             * AppContainer 无权访问 ⇒ `CreateProcessW` 返回 ERROR_ACCESS_DENIED(5)。
             */
            working_directory.as_ptr(),
            &mut startup.startup_info,
            &mut process_information,
        )
    };
    }
    if !attribute_list.is_null() {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
    }
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
