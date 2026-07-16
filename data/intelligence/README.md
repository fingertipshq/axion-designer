# Axion design-intelligence corpus

This directory documents the editable source intent for Axion's built-in offline knowledge engine. The pack-safe runtime snapshot lives in `src/intelligence/catalog.mjs`.

The corpus is original and relationship-based. It covers product, style, color, typography, layout, motion, icons, charts, and UX; it does not reproduce UI UX Pro Max, screenshot-to-code projects, proprietary prompts, brand assets, third-party code, or pixel layouts.

Corpus changes must preserve three invariants: recommendations are deterministic, a ready result has exactly three materially distinct complete-surface recipes, and an under-specified brief returns `needs-clarification` without a silent generic fallback.

