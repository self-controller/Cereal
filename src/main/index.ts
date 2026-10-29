import { WIDGET_HOST_FLAG } from './widget/protocol'

// One binary, two roles: the app itself, or the small process that hosts the floating widget under XWayland
// (widget/host.ts, started by widget/controller.ts). Both are separate entries in out/main.
if (process.argv.includes(WIDGET_HOST_FLAG)) void import('./widget/host')
else void import('./app')
