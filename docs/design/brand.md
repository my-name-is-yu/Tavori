# PulSeed Brand Design Guide

## Overview

PulSeed is an AI agent orchestrator that gives existing agents the drive to persist. The brand sits at the intersection of a professional developer tool and a warm, approachable character-driven product — think GitHub's Mona Lisa, or Rust's Ferris. Playful mascot, serious infrastructure.

---

## Mascot: Seedy

Seedy is the heart of the PulSeed brand. A cute, round cream/white seed with two solid black oval eyes and a green sprout with two leaves on top. The design is deliberately minimal and kawaii — nothing extraneous.

### Anatomy

- **Body**: Round, slightly squashed circle. Fill: `#F5F0E8` (Seed Cream). No outline, or a very subtle `#E0D9CE` stroke at 1px.
- **Eyes**: Two solid black ovals (`#1A1A1A`), symmetrically placed, slightly below center.
- **Sprout**: Single stem with two small rounded leaves. Fill: `#4CAF50` (Sprout Green), slightly darker on the underside (`#2E7D32`).
- **Expression**: Conveyed entirely through eye position — no mouth by default.

### Character States

Used across CLI output, TUI, documentation, and error pages.

| State | Eye Position | Notes |
|-------|-------------|-------|
| Default | Centered, neutral | Standard Seedy |
| Thinking | Slightly up-right | Agent is processing |
| Success | Slight downward curve (smile shadow) | Goal achieved |
| Error | Angled inward, pointing down | Task failure |
| Active / Running | Normal, sprout leaves slightly tilted | Animated in TUI |

### Usage Rules

- Minimum size: **24px** (icon contexts); recommended minimum for legible states: **48px**
- Always maintain aspect ratio. Never stretch or skew.
- Never rotate the body.
- Never recolor Seedy — the cream body and green sprout are fixed.
- On dark backgrounds: add a subtle radial glow (`#4CAF50` at 20% opacity, ~1.5x body radius).
- Seedy should always face forward (eyes centered or slightly offset by state).

---

## Color Palette

### Core Colors

| Name | Hex | Usage |
|------|-----|-------|
| Sprout Green | `#4CAF50` | Primary brand color, CTAs, links, active states |
| Deep Leaf | `#2E7D32` | Hover states, dark variant of primary |
| Fresh Mint | `#A5D6A7` | Badges, highlights, light-mode accents |
| Seed Cream | `#F5F0E8` | Seedy's body, card backgrounds (light mode) |
| Eye Black | `#1A1A1A` | Seedy's eyes, body text (light mode) |
| Warm White | `#FAFAF7` | Page background (light mode) |

### Dark Mode

| Name | Hex | Usage |
|------|-----|-------|
| Dark BG | `#0D1117` | Page background |
| Dark Surface | `#161B22` | Card / panel backgrounds |
| Dark Border | `#30363D` | Borders, dividers |
| Dark Text | `#E6EDF3` | Body text |

> In dark mode, Seed Cream (`#F5F0E8`) is still used for Seedy's body — the warmth is intentional and should not be replaced with a cool white.

### Semantic Colors

| Name | Hex | Usage |
|------|-----|-------|
| Success | `#4CAF50` | Same as primary — growth equals success |
| Warning | `#FFB74D` | Stall detection, caution states |
| Error | `#EF5350` | Task failure, critical issues |
| Info | `#42A5F5` | Informational messages, neutral hints |

---

## Typography

| Role | Font | Notes |
|------|------|-------|
| Headings | Quicksand | Round letterforms echo Seedy's shape; weights 500–700 |
| Body | Inter | Clean, neutral, excellent at small sizes |
| Code / Monospace | JetBrains Mono | CLI output, code blocks, inline code |
| Japanese | Rounded Mplus 1c | 丸ゴシック — keeps the round, friendly feel in Japanese contexts |

### Scale (rem, base 16px)

| Level | Size | Weight | Line Height |
|-------|------|--------|-------------|
| H1 | 2rem | 700 | 1.2 |
| H2 | 1.5rem | 600 | 1.3 |
| H3 | 1.25rem | 600 | 1.4 |
| Body | 1rem | 400 | 1.6 |
| Small / Caption | 0.875rem | 400 | 1.5 |
| Code | 0.875rem | 400 | 1.6 |

---

## Shape & Spacing

### Border Radius

| Context | Radius |
|---------|--------|
| Default (buttons, inputs) | `8px` |
| Cards, panels | `12px` |
| Avatars, Seedy icon | `50%` |
| Badges, chips | `6px` |

### Spacing Scale

Base unit: `4px`. Use multiples: 4, 8, 12, 16, 24, 32, 48, 64.

---

## Logo Lockup

The standard lockup is: **Seedy icon** + **"PulSeed"** wordmark in Quicksand Bold, set in Sprout Green or Eye Black depending on background.

- **Horizontal lockup**: icon left, wordmark right, 12px gap.
- **Stacked lockup**: icon above, wordmark below, 8px gap. Use when width is constrained.
- **Icon only**: acceptable at sizes below 120px wide, or in favicon/app icon contexts.

### Wordmark Color

| Background | Wordmark Color |
|------------|---------------|
| Warm White / light | `#1A1A1A` (Eye Black) |
| Dark BG / dark surface | `#E6EDF3` (Dark Text) |
| On Sprout Green | `#FAFAF7` (Warm White) |

### Asset Files

**Favicon sync rule**: `assets/favicon.svg` is the canonical favicon source. `web/src/app/icon.svg` must be kept in sync with it. When updating the favicon, copy the changes to both files.

---

## Dark Mode Compatibility

The palette is designed to work in both modes without redesign:

- Swap page background: `#FAFAF7` → `#0D1117`
- Swap card surface: `#F5F0E8` → `#161B22`
- Seedy's body color (`#F5F0E8`) stays the same — it provides warmth against the dark background.
- Sprout Green (`#4CAF50`) works on both backgrounds without adjustment.
- Add glow to Seedy in dark mode: `box-shadow: 0 0 16px rgba(76, 175, 80, 0.2)`.

---

## Tone of Voice

### Principles

- **Friendly but competent.** Seedy helps your agents grow — this is serious tooling wrapped in an approachable package.
- **Technical when needed, approachable always.** Use precise terminology without being cold.
- **Never condescending.** Don't over-explain to experienced developers.
- **Never overly casual.** Emoji in documentation should be rare and purposeful.

### Voice Examples

| Context | Good | Avoid |
|---------|------|-------|
| CLI success | `Goal reached. Seedy is proud.` | `LGTM bro!!!` |
| CLI error | `Task failed after 3 retries. Check the adapter logs.` | `Uh oh, something broke :( :( :(` |
| Docs intro | `PulSeed gives your agents the drive to persist.` | `PulSeed is AMAZING and will change everything!` |
| Stall warning | `Agent appears stalled. Escalating to next strategy.` | `Hmm, not sure what's happening here` |

### Key Brand Line

> **"PulSeed gives your agents the drive to persist."**

Secondary lines:
- "Your agents think. Seedy makes sure they keep going."
- "Orchestrate with intent. Persist with purpose."

---

## CLI / TUI Usage

In terminal contexts, Seedy is represented through ASCII/Unicode and colored output using the palette above.

```
  (  )    ← Seed body (no color / bold white)
  (oo)    ← Eyes
  /||\    ← Sprout (green)
```

ANSI color mapping:
- Sprout Green → `\x1b[32m` (standard green) or `\x1b[38;2;76;175;80m` (true color)
- Warning → `\x1b[33m` / `\x1b[38;2;255;183;77m`
- Error → `\x1b[31m` / `\x1b[38;2;239;83;80m`
- Dim / secondary text → `\x1b[2m`

---

## Do / Don't Summary

| Do | Don't |
|----|-------|
| Use Sprout Green as the primary action color | Use multiple competing accent colors |
| Keep Seedy round and unmodified | Stretch, rotate, or recolor Seedy |
| Pair Quicksand headings with Inter body | Use decorative or serif fonts for body text |
| Add glow to Seedy on dark backgrounds | Place Seedy on a background without contrast |
| Match font and border-radius to Seedy's roundness | Use harsh corners (0px radius) in brand contexts |
| Keep copy direct and technically precise | Use filler phrases like "leveraging synergies" |
