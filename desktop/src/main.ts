import { getCurrentWindow } from "@tauri-apps/api/window";
import { mountConsole } from "./console";
import { buildPanel } from "./tools/build";
import { followPanel } from "./tools/follow";
import { chainPanel } from "./tools/chain";
import { unfollowPanel } from "./tools/unfollow";
import { dmPanel } from "./tools/dm";

// Guarantee the titlebar regardless of a stale dev window (native title is set at Rust launch).
void getCurrentWindow().setTitle("Xperiment").catch(() => {});

mountConsole([buildPanel, followPanel, chainPanel, unfollowPanel, dmPanel]);
