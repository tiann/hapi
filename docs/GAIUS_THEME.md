# Gaius Theme

A warm, earthy color theme inspired by historical pigments. Ships with light and dark variants.

## Design Philosophy

Warm, sophisticated palette built around five named historical pigments. Light variant uses a warm pearl base; dark variant uses a deep slate base. Both maintain visual hierarchy with carefully calibrated opacity overlays for subtle UI layering.

## Color Palette

| Pigment | Light | Dark | Usage |
|---|---|---|---|
| **Cinnabar** | `#b04440` | `#d06058` | Links, errors, destructive actions |
| **Verdigris** | `#3a7868` | `#68b8a0` | Success, positive states |
| **Lapis** | `#4068a0` | `#6890c8` | Info, neutral highlights |
| **Gold** | `#b07830` | `#d0a060` | Warnings |
| **Violet** | `#6a5090` | `#a088c0` | Accent, secondary highlights |

---

## Gaius Light

Base: `#f8f5f2` (warm pearl) / Text: `#2a2832` (dark slate)

### Core

| Token | Value | Description |
|---|---|---|
| `--app-bg` | `#f8f5f2` | Background |
| `--app-fg` | `#2a2832` | Text |
| `--app-hint` | `#85808a` | Muted/secondary text |
| `--app-link` | `#b04440` | Links (cinnabar) |
| `--app-button` | `#2a2832` | Button background |
| `--app-button-text` | `#f8f5f2` | Button text |
| `--app-banner-bg` | `#eceae6` | Banner background |
| `--app-banner-text` | `#2a2832` | Banner text |
| `--app-secondary-bg` | `#f0ede9` | Secondary background |

### Surfaces & Borders

| Token | Value |
|---|---|
| `--app-border` | `rgba(42, 40, 50, 0.10)` |
| `--app-divider` | `rgba(42, 40, 50, 0.07)` |
| `--app-subtle-bg` | `rgba(42, 40, 50, 0.03)` |
| `--app-code-bg` | `#f0ede8` |
| `--app-inline-code-bg` | `rgba(42, 40, 50, 0.05)` |
| `--app-selected-bg` | `rgba(176, 68, 64, 0.06)` |

### Diff

| Token | Value |
|---|---|
| `--app-diff-added-bg` | `#e4edd8` |
| `--app-diff-added-text` | `#2a2832` |
| `--app-diff-removed-bg` | `#f2dcd8` |
| `--app-diff-removed-text` | `#2a2832` |

### Status Colors

| Token | Value | Pigment |
|---|---|---|
| `--app-git-staged-color` | `#3a7868` | Verdigris |
| `--app-git-unstaged-color` | `#b07830` | Gold |
| `--app-git-deleted-color` | `#b84440` | Cinnabar |
| `--app-git-renamed-color` | `#4068a0` | Lapis |
| `--app-git-untracked-color` | `#85808a` | Muted |

### Badges

| Type | Background | Text | Border |
|---|---|---|---|
| Info | `rgba(64, 104, 160, 0.10)` | `#3a5888` | `rgba(64, 104, 160, 0.20)` |
| Warning | `rgba(176, 120, 48, 0.12)` | `#8a5820` | `rgba(176, 120, 48, 0.22)` |
| Success | `rgba(58, 120, 104, 0.10)` | `#2a6858` | `rgba(58, 120, 104, 0.20)` |
| Error | `rgba(184, 68, 64, 0.10)` | `#983838` | `rgba(184, 68, 64, 0.20)` |

### Brand/Flavor Accents

| Name | Color | Background | Border |
|---|---|---|---|
| Claude | `#a04038` | `rgba(160, 64, 56, 0.08)` | `rgba(160, 64, 56, 0.18)` |
| Codex | `#2a6858` | `rgba(42, 104, 88, 0.08)` | `rgba(42, 104, 88, 0.18)` |
| Gemini | `#3a5888` | `rgba(58, 88, 136, 0.08)` | `rgba(58, 88, 136, 0.18)` |
| OpenCode | `#6a5090` | `rgba(106, 80, 144, 0.08)` | `rgba(106, 80, 144, 0.18)` |

### Misc

| Token | Value |
|---|---|
| `--app-perm-warning` | `#b84430` |

---

## Gaius Dark

Base: `#1e1d22` (deep slate) / Text: `#e6e3de` (light cream)

### Core

| Token | Value | Description |
|---|---|---|
| `--app-bg` | `#1e1d22` | Background |
| `--app-fg` | `#e6e3de` | Text |
| `--app-hint` | `#88848e` | Muted/secondary text |
| `--app-link` | `#d06058` | Links (coral) |
| `--app-button` | `#e6e3de` | Button background |
| `--app-button-text` | `#1e1d22` | Button text |
| `--app-banner-bg` | `#2a2930` | Banner background |
| `--app-banner-text` | `#e6e3de` | Banner text |
| `--app-secondary-bg` | `#252428` | Secondary background |

### Surfaces & Borders

| Token | Value |
|---|---|
| `--app-border` | `rgba(230, 227, 222, 0.08)` |
| `--app-divider` | `rgba(230, 227, 222, 0.06)` |
| `--app-subtle-bg` | `rgba(230, 227, 222, 0.04)` |
| `--app-code-bg` | `#252430` |
| `--app-inline-code-bg` | `rgba(230, 227, 222, 0.07)` |
| `--app-selected-bg` | `rgba(208, 96, 88, 0.06)` |

### Diff

| Token | Value |
|---|---|
| `--app-diff-added-bg` | `rgba(80, 150, 130, 0.12)` |
| `--app-diff-added-text` | `#d8d5d0` |
| `--app-diff-removed-bg` | `rgba(200, 80, 70, 0.12)` |
| `--app-diff-removed-text` | `#d8d5d0` |

### Status Colors

| Token | Value |
|---|---|
| `--app-git-staged-color` | `#68b8a0` |
| `--app-git-unstaged-color` | `#d0a060` |
| `--app-git-deleted-color` | `#d87068` |
| `--app-git-renamed-color` | `#6890c8` |
| `--app-git-untracked-color` | `#88848e` |

### Badges

| Type | Background | Text | Border |
|---|---|---|---|
| Info | `rgba(104, 144, 200, 0.12)` | `#6890c8` | `rgba(104, 144, 200, 0.20)` |
| Warning | `rgba(208, 160, 96, 0.15)` | `#d0a060` | `rgba(208, 160, 96, 0.25)` |
| Success | `rgba(104, 184, 160, 0.10)` | `#68b8a0` | `rgba(104, 184, 160, 0.20)` |
| Error | `rgba(216, 112, 104, 0.12)` | `#d87068` | `rgba(216, 112, 104, 0.22)` |

### Brand/Flavor Accents

| Name | Color | Background | Border |
|---|---|---|---|
| Claude | `#d08858` | `rgba(208, 136, 88, 0.10)` | `rgba(208, 136, 88, 0.20)` |
| Codex | `#68b8a0` | `rgba(104, 184, 160, 0.10)` | `rgba(104, 184, 160, 0.20)` |
| Gemini | `#6890c8` | `rgba(104, 144, 200, 0.10)` | `rgba(104, 144, 200, 0.20)` |
| OpenCode | `#a088c0` | `rgba(160, 136, 192, 0.10)` | `rgba(160, 136, 192, 0.20)` |

### Misc

| Token | Value |
|---|---|
| `--app-perm-warning` | `#d08050` |

---

## Raw CSS

Copy-paste ready for use in other projects. Apply via `data-theme` attribute on a root element.

### Gaius Light

```css
[data-theme="gaius-light"] {
    /* Primary — warm pearl base */
    --app-bg: #f8f5f2;
    --app-fg: #2a2832;
    --app-hint: #85808a;
    --app-link: #b04440;
    --app-button: #2a2832;
    --app-button-text: #f8f5f2;
    --app-banner-bg: #eceae6;
    --app-banner-text: #2a2832;
    --app-secondary-bg: #f0ede9;
    --app-selected-bg: rgba(176, 68, 64, 0.06);

    /* Overlays */
    --app-border: rgba(42, 40, 50, 0.10);
    --app-divider: rgba(42, 40, 50, 0.07);
    --app-subtle-bg: rgba(42, 40, 50, 0.03);
    --app-code-bg: #f0ede8;
    --app-inline-code-bg: rgba(42, 40, 50, 0.05);

    /* Diffs — verdigris added, cinnabar removed */
    --app-diff-added-bg: #e4edd8;
    --app-diff-added-text: #2a2832;
    --app-diff-removed-bg: #f2dcd8;
    --app-diff-removed-text: #2a2832;

    /* Git status */
    --app-git-staged-color: #3a7868;
    --app-git-unstaged-color: #b07830;
    --app-git-deleted-color: #b84440;
    --app-git-renamed-color: #4068a0;
    --app-git-untracked-color: #85808a;

    /* Badges — lapis, gold, verdigris, cinnabar */
    --app-badge-info-bg: rgba(64, 104, 160, 0.10);
    --app-badge-info-text: #3a5888;
    --app-badge-info-border: rgba(64, 104, 160, 0.20);
    --app-badge-warning-bg: rgba(176, 120, 48, 0.12);
    --app-badge-warning-text: #8a5820;
    --app-badge-warning-border: rgba(176, 120, 48, 0.22);
    --app-badge-success-bg: rgba(58, 120, 104, 0.10);
    --app-badge-success-text: #2a6858;
    --app-badge-success-border: rgba(58, 120, 104, 0.20);
    --app-badge-error-bg: rgba(184, 68, 64, 0.10);
    --app-badge-error-text: #983838;
    --app-badge-error-border: rgba(184, 68, 64, 0.20);

    --app-perm-warning: #b84430;

    /* Agent flavors — cinnabar, verdigris, lapis, violet */
    --app-flavor-claude: #a04038;
    --app-flavor-claude-bg: rgba(160, 64, 56, 0.08);
    --app-flavor-claude-border: rgba(160, 64, 56, 0.18);
    --app-flavor-codex: #2a6858;
    --app-flavor-codex-bg: rgba(42, 104, 88, 0.08);
    --app-flavor-codex-border: rgba(42, 104, 88, 0.18);
    --app-flavor-gemini: #3a5888;
    --app-flavor-gemini-bg: rgba(58, 88, 136, 0.08);
    --app-flavor-gemini-border: rgba(58, 88, 136, 0.18);
    --app-flavor-opencode: #6a5090;
    --app-flavor-opencode-bg: rgba(106, 80, 144, 0.08);
    --app-flavor-opencode-border: rgba(106, 80, 144, 0.18);
}
```

### Gaius Dark

```css
[data-theme="gaius-dark"] {
    /* Primary — deep slate base */
    --app-bg: #1e1d22;
    --app-fg: #e6e3de;
    --app-hint: #88848e;
    --app-link: #d06058;
    --app-button: #e6e3de;
    --app-button-text: #1e1d22;
    --app-banner-bg: #2a2930;
    --app-banner-text: #e6e3de;
    --app-secondary-bg: #252428;
    --app-selected-bg: rgba(208, 96, 88, 0.06);

    /* Overlays */
    --app-border: rgba(230, 227, 222, 0.08);
    --app-divider: rgba(230, 227, 222, 0.06);
    --app-subtle-bg: rgba(230, 227, 222, 0.04);
    --app-code-bg: #252430;
    --app-inline-code-bg: rgba(230, 227, 222, 0.07);

    /* Diffs */
    --app-diff-added-bg: rgba(80, 150, 130, 0.12);
    --app-diff-added-text: #d8d5d0;
    --app-diff-removed-bg: rgba(200, 80, 70, 0.12);
    --app-diff-removed-text: #d8d5d0;

    /* Git status */
    --app-git-staged-color: #68b8a0;
    --app-git-unstaged-color: #d0a060;
    --app-git-deleted-color: #d87068;
    --app-git-renamed-color: #6890c8;
    --app-git-untracked-color: #88848e;

    /* Badges */
    --app-badge-info-bg: rgba(104, 144, 200, 0.12);
    --app-badge-info-text: #6890c8;
    --app-badge-info-border: rgba(104, 144, 200, 0.20);
    --app-badge-warning-bg: rgba(208, 160, 96, 0.15);
    --app-badge-warning-text: #d0a060;
    --app-badge-warning-border: rgba(208, 160, 96, 0.25);
    --app-badge-success-bg: rgba(104, 184, 160, 0.10);
    --app-badge-success-text: #68b8a0;
    --app-badge-success-border: rgba(104, 184, 160, 0.20);
    --app-badge-error-bg: rgba(216, 112, 104, 0.12);
    --app-badge-error-text: #d87068;
    --app-badge-error-border: rgba(216, 112, 104, 0.22);

    --app-perm-warning: #d08050;

    /* Agent flavors */
    --app-flavor-claude: #d08858;
    --app-flavor-claude-bg: rgba(208, 136, 88, 0.10);
    --app-flavor-claude-border: rgba(208, 136, 88, 0.20);
    --app-flavor-codex: #68b8a0;
    --app-flavor-codex-bg: rgba(104, 184, 160, 0.10);
    --app-flavor-codex-border: rgba(104, 184, 160, 0.20);
    --app-flavor-gemini: #6890c8;
    --app-flavor-gemini-bg: rgba(104, 144, 200, 0.10);
    --app-flavor-gemini-border: rgba(104, 144, 200, 0.20);
    --app-flavor-opencode: #a088c0;
    --app-flavor-opencode-bg: rgba(160, 136, 192, 0.10);
    --app-flavor-opencode-border: rgba(160, 136, 192, 0.20);
}
```

---

## Token Reference

Full list of CSS custom properties used:

```
--app-bg
--app-fg
--app-hint
--app-link
--app-button
--app-button-text
--app-banner-bg
--app-banner-text
--app-secondary-bg
--app-selected-bg
--app-border
--app-divider
--app-subtle-bg
--app-code-bg
--app-inline-code-bg
--app-diff-added-bg
--app-diff-added-text
--app-diff-removed-bg
--app-diff-removed-text
--app-git-staged-color
--app-git-unstaged-color
--app-git-deleted-color
--app-git-renamed-color
--app-git-untracked-color
--app-badge-info-bg
--app-badge-info-text
--app-badge-info-border
--app-badge-warning-bg
--app-badge-warning-text
--app-badge-warning-border
--app-badge-success-bg
--app-badge-success-text
--app-badge-success-border
--app-badge-error-bg
--app-badge-error-text
--app-badge-error-border
--app-flavor-claude
--app-flavor-claude-bg
--app-flavor-claude-border
--app-flavor-codex
--app-flavor-codex-bg
--app-flavor-codex-border
--app-flavor-gemini
--app-flavor-gemini-bg
--app-flavor-gemini-border
--app-flavor-opencode
--app-flavor-opencode-bg
--app-flavor-opencode-border
--app-perm-warning
```
