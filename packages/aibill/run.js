#!/usr/bin/env node
// Thin alias: check your AI bill — same CLI, shorter to type and say on video.
// All logic lives in ai-spend-agent — this file must never grow.
import("ai-spend-agent").then(({ runMain }) => runMain());
