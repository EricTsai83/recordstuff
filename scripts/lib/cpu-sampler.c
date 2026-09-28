// Per-process CPU sampler for `pnpm measure:cpu` and `pnpm matrix` (plan 049), after Cap's
// scripts/instant-mode-process-sampler.c. Development only, never shipped.
//
// usage: cpu-sampler <root-pid> <interval-ms> <samples, 0 = until killed> [follow-name ...]
//
// Every interval it lists all processes, keeps the root and its descendants plus any process
// whose name is one of the follow names (system helpers outside the tree, such as
// VTEncoderXPCService), reads proc_pid_rusage for each and prints one JSON line of cumulative
// counters. `ps` reports CPU time in hundredths of a second, too coarse for an idle second in
// which 0.2% of a core is 2 ms, and its %cpu is a decaying average; these counters are exact.
// Deltas and statistics are computed by cpu-sampler.mts.
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static void json_string(const char *text) {
  putchar('"');
  for (const char *c = text; *c; c++) {
    if (*c == '"' || *c == '\\') putchar('\\');
    if ((unsigned char)*c >= 0x20) putchar(*c);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: cpu-sampler <root-pid> <interval-ms> <samples> [follow-name ...]\n");
    return 2;
  }
  pid_t root = (pid_t)atoi(argv[1]);
  long interval_ms = atol(argv[2]);
  long samples = atol(argv[3]);
  mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  setvbuf(stdout, NULL, _IOLBF, 0);
  uint64_t next = mach_absolute_time();
  const uint64_t step = (uint64_t)interval_ms * 1000000ULL * timebase.denom / timebase.numer;
  for (long n = 0; samples == 0 || n < samples; n++) {
    int capacity = proc_listallpids(NULL, 0) + 64;
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    pid_t *parents = calloc((size_t)capacity, sizeof(pid_t));
    char (*names)[2 * MAXCOMLEN + 1] = calloc((size_t)capacity, sizeof(*names));
    char *keep = calloc((size_t)capacity, 1);
    if (!pids || !parents || !names || !keep) return 1;
    int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    for (int i = 0; i < count; i++) {
      struct proc_bsdinfo info;
      if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info)) {
        parents[i] = (pid_t)info.pbi_ppid;
        strlcpy(names[i], info.pbi_name[0] ? info.pbi_name : info.pbi_comm, sizeof(names[i]));
      }
      if (pids[i] == root) keep[i] = 1;
      for (int f = 4; f < argc; f++) if (strcmp(names[i], argv[f]) == 0) keep[i] = 2;
    }
    // Descendants of the root, to any depth.
    for (int changed = 1; changed;) {
      changed = 0;
      for (int i = 0; i < count; i++) {
        if (keep[i]) continue;
        for (int j = 0; j < count; j++) {
          if (keep[j] == 1 && parents[i] == pids[j]) { keep[i] = 1; changed = 1; break; }
        }
      }
    }
    uint64_t now = mach_absolute_time();
    printf("{\"t_ns\":%llu,\"procs\":[", (unsigned long long)(now * timebase.numer / timebase.denom));
    int first = 1;
    for (int i = 0; i < count; i++) {
      if (!keep[i]) continue;
      struct rusage_info_v6 usage;
      if (proc_pid_rusage(pids[i], RUSAGE_INFO_V6, (rusage_info_t *)&usage) != 0) continue;
      uint64_t cpu = (usage.ri_user_time + usage.ri_system_time) * timebase.numer / timebase.denom;
      printf("%s{\"pid\":%d,\"ppid\":%d,\"name\":", first ? "" : ",", pids[i], parents[i]);
      json_string(names[i]);
      printf(",\"followed\":%s,\"cpu_ns\":%llu,\"idle_wakeups\":%llu,\"interrupt_wakeups\":%llu,\"energy_nj\":%llu,\"resident_bytes\":%llu}",
        keep[i] == 2 ? "true" : "false", (unsigned long long)cpu, (unsigned long long)usage.ri_pkg_idle_wkups,
        (unsigned long long)usage.ri_interrupt_wkups, (unsigned long long)usage.ri_energy_nj,
        (unsigned long long)usage.ri_resident_size);
      first = 0;
    }
    printf("]}\n");
    free(pids); free(parents); free(names); free(keep);
    // A fixed schedule, so a slow sample does not stretch every later interval.
    next += step;
    uint64_t after = mach_absolute_time();
    if (next > after) usleep((useconds_t)((next - after) * timebase.numer / timebase.denom / 1000));
    else next = after;
  }
  return 0;
}
