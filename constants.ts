/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * View type constants for all StoryLine views.
 *
 * These live in their own module to avoid circular imports between
 * view files and the ViewSwitcher component.
 */
export const BOARD_VIEW_TYPE = 'story-line-board';
export const TIMELINE_VIEW_TYPE = 'story-line-timeline';
export const STORYLINE_VIEW_TYPE = 'story-line-storyline';
export const CHARACTER_VIEW_TYPE = 'story-line-character';
export const STATS_VIEW_TYPE = 'story-line-stats';
export const PLOTGRID_VIEW_TYPE = 'story-line-plotgrid';
export const LOCATION_VIEW_TYPE = 'story-line-location';
export const HELP_VIEW_TYPE = 'story-line-help';
export const NAVIGATOR_VIEW_TYPE = 'story-line-navigator';
export const CODEX_VIEW_TYPE = 'story-line-codex';
export const SCENE_INSPECTOR_VIEW_TYPE = 'story-line-scene-inspector';
export const MANUSCRIPT_VIEW_TYPE = 'story-line-manuscript';
export const RESEARCH_VIEW_TYPE = 'story-line-research';
export const NOTES_VIEW_TYPE = 'story-line-notes';
export const SYNOPSIS_VIEW_TYPE = 'story-line-synopsis';
export const DETAILS_VIEW_TYPE = 'story-line-scene-details';

/**
 * Maximum number of title characters used when building a scene's filename.
 * Filenames also carry a prefix and/or " - Notes" suffix plus the ".md"
 * extension, so this stays comfortably under the common 255-byte OS limit
 * while no longer chopping realistic scene titles.
 */
export const MAX_FILENAME_TITLE_LENGTH = 200;
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
