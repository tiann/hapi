# Desktop Launcher is a separate workspace

HAPI Desktop will live in a new `desktop/` workspace instead of being folded into the existing Web PWA or CLI package. The launcher has distinct desktop responsibilities such as tray behavior, process management, packaged binaries, and live console display, so keeping it separate avoids blurring the Web App and CLI boundaries.
