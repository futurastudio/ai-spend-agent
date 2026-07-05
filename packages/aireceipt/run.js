#!/usr/bin/env node
// Thin alias: the AI Receipt brand name for the same CLI.
// All logic lives in ai-spend-agent — this file must never grow.
import("ai-spend-agent").then(({ runMain }) => runMain());
