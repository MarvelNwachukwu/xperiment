import { mountConsole } from "./console";
import { buildPanel } from "./tools/build";
import { followPanel } from "./tools/follow";
import { chainPanel } from "./tools/chain";
import { unfollowPanel } from "./tools/unfollow";

mountConsole([buildPanel, followPanel, chainPanel, unfollowPanel]);
