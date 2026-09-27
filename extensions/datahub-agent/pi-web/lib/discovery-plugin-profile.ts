import { loadSkillsFromDir, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Fixed first-party inline extension and skill, no actor/project packages,
 * extensions, prompts, themes or context files. SDK tools must ALSO be restricted
 * to PLUGIN_DEVELOPMENT_TOOLS by the caller; skill text is not the boundary.
 */
export function pluginDevelopmentResources(extension: ExtensionFactory) {
  return {
    noExtensions: true,
    additionalExtensionPaths: [],
    extensionFactories: [extension],
    noSkills: true,
    skillsOverride: () => loadSkillsFromDir({
      // A server filesystem directory, not a webpack URL asset/module request.
      dir: resolve(dirname(fileURLToPath(import.meta.url)), "../skills/discovery-plugin-dev"),
      source: "path",
    }),
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
}
