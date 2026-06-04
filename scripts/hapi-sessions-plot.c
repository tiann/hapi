/*
 * hapi-sessions-plot — agent chart (nvtop plot.c ACS corner algorithm, UTF-8).
 *
 * Build:  cc -O2 -Wall -o hapi-sessions-plot hapi-sessions-plot.c
 * Input:  JSON on stdin
 * Output: chart panel lines for hapi-sessions-health.sh (UTF-8 ─│┼ + ANSI)
 */

#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_SAMPLES 512
#define MAX_W 128
#define MAX_H 24

enum { COL_NONE = 0, COL_WORK = 1, COL_PEAK = 2 };

/* UTF-8 box glyphs matching ncurses ACS used in nvtop src/plot.c */
enum {
    CH_NONE = 0,
    CH_H = 1,
    CH_V = 2,
    CH_UL = 3, /* └ ACS_ULCORNER */
    CH_UR = 4, /* ┐ ACS_URCORNER */
    CH_LL = 5, /* ┌ ACS_LLCORNER */
    CH_LR = 6, /* ┘ ACS_LRCORNER */
};

typedef struct {
    int w, h;
    unsigned char ch[MAX_W * MAX_H];
    unsigned char color[MAX_W * MAX_H];
} Canvas;

static void die(const char *msg) {
    fprintf(stderr, "hapi-sessions-plot: %s\n", msg);
    exit(1);
}

static void fputs_utf8_cp(unsigned int cp) {
    char buf[5];
    int n = 0;
    if (cp < 0x80)
        buf[n++] = (char)cp;
    else if (cp < 0x800) {
        buf[n++] = (char)(0xC0 | (cp >> 6));
        buf[n++] = (char)(0x80 | (cp & 0x3F));
    } else {
        buf[n++] = (char)(0xE0 | (cp >> 12));
        buf[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        buf[n++] = (char)(0x80 | (cp & 0x3F));
    }
    buf[n] = '\0';
    fputs(buf, stdout);
}

static void ansi(bool plain, const char *code) {
    if (!plain && code && code[0])
        fputs(code, stdout);
}

static void ansi_reset(bool plain) {
    if (!plain)
        fputs("\033[0m", stdout);
}

static int json_int(const char *json, const char *key, int def) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p)
        return def;
    p = strchr(p, ':');
    if (!p)
        return def;
    p++;
    while (*p && isspace((unsigned char)*p))
        p++;
    return (int)strtol(p, NULL, 10);
}

static bool json_bool(const char *json, const char *key) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p)
        return false;
    p = strchr(p, ':');
    if (!p)
        return false;
    p++;
    while (*p && isspace((unsigned char)*p))
        p++;
    return strncmp(p, "true", 4) == 0;
}

static int parse_samples(const char *json, int *work, int *peak) {
    const char *p = strstr(json, "\"samples\"");
    if (!p)
        return 0;
    p = strchr(p, '[');
    if (!p)
        return 0;
    p++; /* skip outer samples array '[' */
    int n = 0;
    while (n < MAX_SAMPLES) {
        while (*p && isspace((unsigned char)*p))
            p++;
        if (*p == ']')
            break;
        if (*p != '[') {
            p++;
            continue;
        }
        int w = 0, pe = 0;
        if (sscanf(p, "[%d,%d]", &w, &pe) != 2)
            break;
        work[n] = w;
        peak[n] = pe;
        n++;
        p = strchr(p, ']');
        if (!p)
            break;
        p++;
        if (*p == ',')
            p++;
    }
    return n;
}

static void canvas_init(Canvas *c, int w, int h) {
    c->w = w;
    c->h = h;
    memset(c->ch, 0, (size_t)w * (size_t)h);
    memset(c->color, COL_NONE, (size_t)w * (size_t)h);
}

static void put_ch(Canvas *c, int cx, int cy, unsigned char glyph, int col) {
    if (cx < 0 || cx >= c->w || cy < 0 || cy >= c->h)
        return;
    int i = cy * c->w + cx;
    c->ch[i] = glyph;
    c->color[i] = (unsigned char)col;
}

static void hline_cells(Canvas *c, int x0, int x1, int cy, int col) {
    if (x0 > x1) {
        int t = x0;
        x0 = x1;
        x1 = t;
    }
    for (int cx = x0; cx <= x1; cx++)
        put_ch(c, cx, cy, CH_H, col);
}

static unsigned int glyph_cp(unsigned char g) {
    switch (g) {
    case CH_H:
        return 0x2500;
    case CH_V:
        return 0x2502;
    case CH_UL:
        return 0x2514;
    case CH_UR:
        return 0x2510;
    case CH_LL:
        return 0x250C;
    case CH_LR:
        return 0x2518;
    default:
        return ' ';
    }
}

static int data_level(int rows, int data, int max_y) {
    if (max_y <= 0)
        return rows - 1;
    double increment = (double)max_y / (double)(rows > 1 ? rows - 1 : 1);
    if (increment <= 0)
        return rows - 1;
    return (int)((double)rows - 1.0 - (double)data / increment + 0.5);
}

static void align_scroll(int *work, int *peak, int n, int width) {
    if (n <= 0)
        return;
    if (n >= width) {
        memmove(work, work + n - width, (size_t)width * sizeof(int));
        memmove(peak, peak + n - width, (size_t)width * sizeof(int));
        return;
    }
    int pad = width - n;
    memmove(work + pad, work, (size_t)n * sizeof(int));
    memmove(peak + pad, peak, (size_t)n * sizeof(int));
    for (int i = 0; i < pad; i++) {
        work[i] = -1;
        peak[i] = -1;
    }
}

/* Port of nvtop nvtop_line_plot() for one metric (plot.c). */
static void plot_series_nvtop(Canvas *c, int *vals, int width, int max_y, int col_id) {
    int rows = c->h;
    int lvl_before = -1;
    int last_col = -1;

    for (int col = 0; col < width; col++) {
        if (vals[col] < 0)
            continue;
        int lvl_now = data_level(rows, vals[col], max_y);

        if (last_col < 0) {
            put_ch(c, col, lvl_now, CH_H, col_id);
            lvl_before = lvl_now;
            last_col = col;
            continue;
        }

        if (col > last_col + 1)
            hline_cells(c, last_col + 1, col - 1, lvl_before, col_id);

        if (lvl_before != lvl_now) {
            bool drawing_down = lvl_before < lvl_now;
            int bottom = drawing_down ? lvl_before : lvl_now;
            int top = drawing_down ? lvl_now : lvl_before;
            put_ch(c, col, bottom, drawing_down ? CH_UR : CH_UL, col_id);
            put_ch(c, col, top, drawing_down ? CH_LL : CH_LR, col_id);
            for (int r = bottom + 1; r < top; r++)
                put_ch(c, col, r, CH_V, col_id);
            if (col == last_col + 1)
                put_ch(c, last_col, lvl_before, CH_H, col_id);
        } else {
            if (col == last_col + 1)
                hline_cells(c, last_col, col, lvl_now, col_id);
            else
                put_ch(c, col, lvl_now, CH_H, col_id);
        }

        lvl_before = lvl_now;
        last_col = col;
    }
}

static void nvtop_line_plot(Canvas *c, int *work, int *peak, int width, int max_y) {
    plot_series_nvtop(c, peak, width, max_y, COL_PEAK);
    plot_series_nvtop(c, work, width, max_y, COL_WORK);
}

static void time_axis(char *buf, int plot_w, int watch_sec, int sample_count) {
    memset(buf, ' ', (size_t)plot_w);
    buf[plot_w] = '\0';
    if (plot_w < 4)
        return;
    int filled = sample_count > 0 ? sample_count : 1;
    int total_sec = filled > 1 ? (filled - 1) * watch_sec : 0;
    for (int i = 0; i < 4; i++) {
        int x = (int)(0.5 + (double)i * (double)(plot_w - 1) / 3.0);
        int sec = (int)(0.5 + (double)total_sec * (1.0 - (double)i / 3.0));
        char label[16];
        if (sec == 0)
            snprintf(label, sizeof(label), "-0s");
        else
            snprintf(label, sizeof(label), "-%ds", sec);
        int start = x - (int)strlen(label) + 1;
        if (start < 0)
            start = 0;
        if (start + (int)strlen(label) > plot_w)
            start = plot_w - (int)strlen(label);
        if (start < 0)
            start = 0;
        for (size_t j = 0; label[j] && start + (int)j < plot_w; j++) {
            if (buf[start + (int)j] == ' ')
                buf[start + (int)j] = label[j];
        }
    }
}

static int tick_row_for_value(int val, int max_y, int plot_h) {
    return data_level(plot_h, val, max_y);
}

static void print_box_top(bool plain, int inner_w) {
    const char *fg141 = plain ? "" : "\033[38;5;141m";
    const char *fg213 = plain ? "" : "\033[38;5;213;1m";
    ansi(plain, fg141);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x8c', stdout);
    ansi(plain, fg213);
    fputs(" AGENTS ", stdout);
    ansi_reset(plain);
    int pad = inner_w - 8;
    if (pad < 0)
        pad = 0;
    ansi(plain, fg141);
    for (int i = 0; i < pad; i++)
        fputc('\xe2', stdout), fputc('\x94', stdout), fputc('\x80', stdout);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x90', stdout);
    ansi_reset(plain);
    fputc('\n', stdout);
}

static void print_box_bot(bool plain, int inner_w) {
    const char *fg141 = plain ? "" : "\033[38;5;141m";
    ansi(plain, fg141);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x94', stdout);
    for (int i = 0; i < inner_w; i++)
        fputc('\xe2', stdout), fputc('\x94', stdout), fputc('\x80', stdout);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x98', stdout);
    ansi_reset(plain);
    fputc('\n', stdout);
}

int main(void) {
    char *json = NULL;
    size_t cap = 0, len = 0;
    int ch;
    while ((ch = fgetc(stdin)) != EOF) {
        if (len + 1 >= cap) {
            cap = cap ? cap * 2 : 4096;
            char *n = realloc(json, cap);
            if (!n)
                die("out of memory");
            json = n;
        }
        json[len++] = (char)ch;
    }
    if (!json)
        json = strdup("{}");
    else
        json[len] = '\0';

    int peak_max = json_int(json, "peak", 0);
    int now = json_int(json, "now", 0);
    int outer_w = json_int(json, "width", 30);
    int outer_h = json_int(json, "height", 7);
    int watch_sec = json_int(json, "watch_sec", 15);
    bool plain = json_bool(json, "plain");

    if (outer_w < 14)
        outer_w = 14;
    if (outer_w > MAX_W)
        outer_w = MAX_W;
    if (outer_h < 5)
        outer_h = 5;
    if (outer_h > MAX_H)
        outer_h = MAX_H;
    if (watch_sec < 1)
        watch_sec = 1;

    int work[MAX_SAMPLES], peak[MAX_SAMPLES];
    int n = parse_samples(json, work, peak);
    free(json);

    int inner_w = outer_w >= 2 ? outer_w - 2 : outer_w;
    if (inner_w < 26)
        inner_w = 26;

    int max_y = peak_max;
    for (int i = 0; i < n; i++) {
        if (work[i] > max_y)
            max_y = work[i];
        if (peak[i] > max_y)
            max_y = peak[i];
    }
    if (max_y < 1)
        max_y = 1;

    char ylab[16];
    snprintf(ylab, sizeof(ylab), "%d", max_y);
    int ylab_w = (int)strlen(ylab);
    if (ylab_w < 3)
        ylab_w = 3;

    int plot_w = inner_w - ylab_w - 1;
    if (plot_w < 8)
        plot_w = 8;
    int plot_h = outer_h - 4;
    if (plot_h < 4)
        plot_h = 4;

    int aw[MAX_SAMPLES], ap[MAX_SAMPLES];
    memcpy(aw, work, (size_t)n * sizeof(int));
    memcpy(ap, peak, (size_t)n * sizeof(int));
    align_scroll(aw, ap, n, plot_w);

    Canvas canvas;
    canvas_init(&canvas, plot_w, plot_h);
    nvtop_line_plot(&canvas, aw, ap, plot_w, max_y);

    const char *fg141 = plain ? "" : "\033[38;5;141m";
    const char *fg245 = plain ? "" : "\033[38;5;245m";
    const char *fg46 = plain ? "" : "\033[38;5;46m";
    const char *fg201 = plain ? "" : "\033[38;5;201m";
    const char *fg220 = plain ? "" : "\033[38;5;220m";
    const char *dim = plain ? "" : "\033[2m";
    const char *bold = plain ? "" : "\033[1m";

    print_box_top(plain, inner_w);

    /* legend row inside box */
    ansi(plain, fg141);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x82', stdout);
    ansi_reset(plain);
    for (int i = 0; i < ylab_w; i++)
        fputc(' ', stdout);
    ansi(plain, fg245);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\xa4', stdout);
    ansi_reset(plain);
    fputc(' ', stdout);
    ansi(plain, fg46);
    fputs_utf8_cp(0x2500);
    fputs_utf8_cp(0x2500);
    ansi_reset(plain);
    fprintf(stdout, " working ");
    ansi(plain, fg245);
    fprintf(stdout, "%d", now);
    fputs("  ", stdout);
    ansi_reset(plain);
    ansi(plain, fg201);
    fputs_utf8_cp(0x2500);
    fputs_utf8_cp(0x2500);
    ansi_reset(plain);
    fputs(" peak ", stdout);
    ansi(plain, bold);
    ansi(plain, fg220);
    fprintf(stdout, "%d", max_y);
    ansi_reset(plain);
  /* pad to inner_w */
    int used = ylab_w + 2 + 20;
    for (int i = used; i < inner_w; i++)
        fputc(' ', stdout);
    ansi(plain, fg141);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x82', stdout);
    ansi_reset(plain);
    fputc('\n', stdout);

    int tick_rows[MAX_H];
    for (int i = 0; i < MAX_H; i++)
        tick_rows[i] = -1;
    if (max_y <= 8) {
        for (int tv = 0; tv <= max_y; tv++)
            tick_rows[tick_row_for_value(tv, max_y, plot_h)] = tv;
    } else {
        int ticks[] = {0, max_y / 4, max_y / 2, (3 * max_y) / 4, max_y};
        for (size_t i = 0; i < sizeof(ticks) / sizeof(ticks[0]); i++)
            tick_rows[tick_row_for_value(ticks[i], max_y, plot_h)] = ticks[i];
    }

    for (int row = 0; row < plot_h; row++) {
        ansi(plain, fg141);
        fputc('\xe2', stdout);
        fputc('\x94', stdout);
        fputc('\x82', stdout);
        ansi_reset(plain);
        if (tick_rows[row] >= 0)
            fprintf(stdout, "%*d", ylab_w, tick_rows[row]);
        else
            fprintf(stdout, "%*s", ylab_w, "");
        ansi(plain, fg245);
        fputc('\xe2', stdout);
        fputc('\x94', stdout);
        fputc('\xa4', stdout);
        ansi_reset(plain);
        for (int cx = 0; cx < plot_w; cx++) {
            int i = row * plot_w + cx;
            unsigned char glyph = canvas.ch[i];
            if (!glyph) {
                fputc(' ', stdout);
                continue;
            }
            if (canvas.color[i] == COL_WORK)
                ansi(plain, fg46);
            else if (canvas.color[i] == COL_PEAK)
                ansi(plain, fg201);
            fputs_utf8_cp(glyph_cp(glyph));
            if (!plain && canvas.color[i] != COL_NONE)
                ansi_reset(plain);
        }
        int row_used = ylab_w + 1 + plot_w;
        for (int i = row_used; i < inner_w; i++)
            fputc(' ', stdout);
        ansi(plain, fg141);
        fputc('\xe2', stdout);
        fputc('\x94', stdout);
        fputc('\x82', stdout);
        ansi_reset(plain);
        fputc('\n', stdout);
    }

    char tbuf[MAX_W + 1];
    time_axis(tbuf, plot_w, watch_sec, n);
    ansi(plain, fg141);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x82', stdout);
    ansi_reset(plain);
    fprintf(stdout, "%*s", ylab_w, "");
    ansi(plain, fg245);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\xa4', stdout);
    ansi_reset(plain);
    ansi(plain, dim);
    fputs(tbuf, stdout);
    ansi_reset(plain);
    for (int i = ylab_w + 1 + plot_w; i < inner_w; i++)
        fputc(' ', stdout);
    ansi(plain, fg141);
    fputc('\xe2', stdout);
    fputc('\x94', stdout);
    fputc('\x82', stdout);
    ansi_reset(plain);
    fputc('\n', stdout);

    print_box_bot(plain, inner_w);
    return 0;
}
