// Narrow N-API bridge for the two filesystem contracts Node does not expose:
// Python-compatible advisory locks and exact nanosecond backup timestamps.
#include <node_api.h>
#include <stdint.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#else
#include <sys/file.h>
#include <sys/stat.h>
#include <errno.h>
#endif

static napi_value fail(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}
static bool descriptor(napi_env env, napi_value input, int32_t* fd) {
  return napi_get_value_int32(env, input, fd) == napi_ok && *fd >= 0;
}
static napi_value lock(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t argc = 2; int32_t fd; bool release = false;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2 || !descriptor(env, args[0], &fd) || napi_get_value_bool(env, args[1], &release) != napi_ok)
    return fail(env, "Expected a file descriptor and unlock flag");
  bool granted = true;
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle(fd); OVERLAPPED position = {};
  BOOL ok = release ? UnlockFileEx(handle, 0, 1, 0, &position)
    : LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &position);
  if (!ok) {
    if (!release && GetLastError() == ERROR_LOCK_VIOLATION) granted = false;
    else return fail(env, "Windows session lock operation failed");
  }
#else
  if (flock(fd, release ? LOCK_UN : LOCK_EX | LOCK_NB) != 0) {
    if (!release && (errno == EAGAIN || errno == EWOULDBLOCK)) granted = false;
    else return fail(env, strerror(errno));
  }
#endif
  napi_value result; napi_get_boolean(env, granted, &result); return result;
}
static napi_value set_times(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t argc = 3; int32_t fd; int64_t access, modified; bool exact_access, exact_modified;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3 || !descriptor(env, args[0], &fd)
      || napi_get_value_bigint_int64(env, args[1], &access, &exact_access) != napi_ok
      || napi_get_value_bigint_int64(env, args[2], &modified, &exact_modified) != napi_ok
      || !exact_access || !exact_modified) return fail(env, "Expected exact signed 64-bit nanosecond timestamps");
#ifdef _WIN32
  const int64_t epoch = 116444736000000000LL;
  uint64_t at = (uint64_t)(access / 100 + epoch), mt = (uint64_t)(modified / 100 + epoch);
  FILETIME a = {(DWORD)at, (DWORD)(at >> 32)}, m = {(DWORD)mt, (DWORD)(mt >> 32)};
  if (!SetFileTime((HANDLE)_get_osfhandle(fd), nullptr, &a, &m)) return fail(env, "Windows session timestamp operation failed");
#else
  struct timespec times[2]; int64_t values[2] = {access, modified};
  for (int i = 0; i < 2; ++i) {
    times[i].tv_sec = values[i] / 1000000000LL; times[i].tv_nsec = values[i] % 1000000000LL;
    if (times[i].tv_nsec < 0) { times[i].tv_sec--; times[i].tv_nsec += 1000000000L; }
  }
  if (futimens(fd, times) != 0) return fail(env, strerror(errno));
#endif
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "lock", NAPI_AUTO_LENGTH, lock, nullptr, &function);
  napi_set_named_property(env, exports, "lock", function);
  napi_create_function(env, "setTimes", NAPI_AUTO_LENGTH, set_times, nullptr, &function);
  napi_set_named_property(env, exports, "setTimes", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
