import { mountConsole } from "./console";
import { buildPanel } from "./tools/build";
import { followPanel } from "./tools/follow";

mountConsole([buildPanel, followPanel]);
