// MIT: RoslynWeb's native WASI command integration fixture. Rebuild with scripts/build-wasi-fixture.mjs.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <time.h>
#include <wasi/api.h>

static int generate(int argc, char **argv) {
    const char *input = argc > 2 ? argv[2] : "input.txt";
    const char *output = argc > 3 ? argv[3] : "Generated.cs";
    FILE *file = fopen(input, "r");
    if (!file) { fprintf(stderr, "Cannot read %s: %d\n", input, errno); return 2; }
    int value = 0; if (fscanf(file, "%d", &value) != 1) { fclose(file); return 3; } fclose(file);
    const char *offset = getenv("OFFSET"); if (offset) value += atoi(offset);
    file = fopen(output, "w");
    if (!file) { fprintf(stderr, "Cannot write %s: %d\n", output, errno); return 4; }
    int wrote = fprintf(file, "public static class NativeGenerated { public static int Value => %d; }\n", value);
    int closed = fclose(file); if (wrote < 0 || closed) return 5;
    printf("Generated %s with value %d\n", output, value); return 0;
}
static int io(void) {
    if (mkdir("work", 0777)) return 10;
    int fd = open("work/a.bin", O_CREAT | O_TRUNC | O_RDWR, 0666); if (fd < 0) return 11;
    if (write(fd, "abcde", 5) != 5 || pwrite(fd, "XY", 2, 1) != 2) return 12;
    char buffer[8] = {0}; if (pread(fd, buffer, 5, 0) != 5 || strcmp(buffer, "aXYde")) return 13;
    if (lseek(fd, 0, SEEK_CUR) != 5 || ftruncate(fd, 3)) return 14;
    struct stat statbuf; if (fstat(fd, &statbuf) || statbuf.st_size != 3) return 15;
    close(fd); if (rename("work/a.bin", "work/b.bin")) return 16;
    DIR *directory = opendir("work"); if (!directory) return 17;
    struct dirent *entry; int found = 0; while ((entry = readdir(directory))) if (!strcmp(entry->d_name, "b.bin")) found++;
    closedir(directory); if (found != 1) return 18;
    if (stat("work/b.bin", &statbuf) || statbuf.st_size != 3) return 19;
    FILE *file = fopen("work/b.bin", "a"); if (!file || fputs("Z", file) < 0 || fclose(file)) return 20;
    puts("io:aXYZ"); return 0;
}
static int stdio(int argc, char **argv) {
    char input[64] = {0}; if (!fgets(input, sizeof(input), stdin)) return 30;
    fprintf(stdout, "args:%d:%s\nenv:%s\nstdin:%s", argc, argc > 2 ? argv[2] : "", getenv("GREETING"), input);
    fputs("native stderr\n", stderr);
    struct timespec time; if (clock_gettime(CLOCK_REALTIME, &time) || time.tv_sec < 1) return 31;
    if (clock_gettime(CLOCK_MONOTONIC, &time) || time.tv_sec < 0) return 32;
    uint8_t random[70000]; if (__wasi_random_get(random, sizeof(random))) return 33;
    int varied = 0; for (int i = 1; i < (int)sizeof(random); i++) varied |= random[i] != random[0];
    puts(varied ? "clock+random:ok" : "random:failed"); return varied ? 0 : 34;
}
static int rights(void) {
    int fd = open("rights.bin", O_CREAT | O_RDWR, 0666); if (fd < 0) return 60;
    __wasi_fdstat_t info; if (__wasi_fd_fdstat_get(fd, &info)) return 61;
    if (__wasi_fd_fdstat_set_rights(fd, info.fs_rights_base & ~__WASI_RIGHTS_FD_WRITE, 0)) return 62;
    __wasi_ciovec_t vector = { (const uint8_t *)"x", 1 }; __wasi_size_t written = 0;
    if (__wasi_fd_write(fd, &vector, 1, &written) != __WASI_ERRNO_NOTCAPABLE) return 63;
    close(fd);
    if (__wasi_fd_fdstat_set_rights(3, __WASI_RIGHTS_PATH_OPEN, 0)) return 64;
    if (__wasi_path_create_directory(3, "denied") != __WASI_ERRNO_NOTCAPABLE) return 65;
    puts("rights:enforced"); return 0;
}
static int orphan(void) {
    int old = open("old.bin", O_CREAT | O_RDWR, 0666); if (old < 0) return 70;
    if (write(old, "123456", 6) != 6 || unlink("old.bin")) return 71;
    int next = open("next.bin", O_CREAT | O_RDWR, 0666); if (next < 0) return 72;
    if (write(next, "X", 1) != -1 || errno != __WASI_ERRNO_FBIG) return 73;
    if (close(old) || write(next, "X", 1) != 1) return 74;
    close(next); puts("orphan:quota preserved"); return 0;
}
static int edges(void) {
    __wasi_size_t written = 0;
    if (__wasi_fd_write(1, (const __wasi_ciovec_t *)0, 0x20000000, &written) != __WASI_ERRNO_FAULT) return 80;
    int first = open("edge.bin", O_CREAT | O_RDWR, 0666); if (first < 0) return 81;
    if (__wasi_fd_renumber(first, first + 1)) return 82;
    int second = open("second.bin", O_CREAT | O_RDWR, 0666); if (second <= first + 1) return 83;
    if (write(first + 1, "original", 8) != 8 || write(second, "next", 4) != 4) return 84;
    if (__wasi_path_unlink_file(3, "edge.bin/") != __WASI_ERRNO_NOTDIR) return 85;
    if (__wasi_path_unlink_file(3, "edge.bin/../second.bin") != __WASI_ERRNO_NOTDIR) return 86;
    if (__wasi_path_unlink_file(3, "absent/../second.bin") != __WASI_ERRNO_NOENT) return 87;
    if (__wasi_path_unlink_file(3, "") != __WASI_ERRNO_NOENT) return 88;
    if (mkdir("trailing/", 0777)) return 89;
    close(first + 1); close(second); puts("edges:checked"); return 0;
}
int main(int argc, char **argv) {
    if (argc < 2) return 64;
    if (!strcmp(argv[1], "generate")) return generate(argc, argv);
    if (!strcmp(argv[1], "io")) return io();
    if (!strcmp(argv[1], "edges")) return edges();
    if (!strcmp(argv[1], "spin")) { volatile unsigned spin = 0; for (;;) spin++; }
    if (!strcmp(argv[1], "rights")) return rights();
    if (!strcmp(argv[1], "orphan")) return orphan();
    if (!strcmp(argv[1], "stdio")) return stdio(argc, argv);
    if (!strcmp(argv[1], "exit")) exit(atoi(argv[2]));
    if (!strcmp(argv[1], "unsupported")) { int error = __wasi_path_symlink("source", 4, "link"); printf("symlink:%d\n", error); return error == __WASI_ERRNO_NOSYS ? 0 : 1; }
    if (!strcmp(argv[1], "remove")) { if (unlink("old.txt")) return 50; puts("removed"); return 0; }
    if (!strcmp(argv[1], "escape")) { FILE *file = fopen("../../outside.txt", "w"); if (file) { fclose(file); return 1; } printf("escape:%d\n", errno); return 0; }
    if (!strcmp(argv[1], "quota")) { FILE *file = fopen("large.bin", "w"); if (!file) return 1; char buffer[1024] = {0}; size_t wrote = fwrite(buffer, 1, sizeof(buffer), file); int closed = fclose(file); printf("quota:%d\n", wrote != sizeof(buffer) || closed != 0); return (wrote != sizeof(buffer) || closed != 0) ? 0 : 1; }
    return 65;
}
