/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { App, Modal, Notice, Setting } from 'obsidian';
import { UniversalFieldTemplate, UniversalFieldType, ComputeFunction, generateId, suggestTopLevelKey, isReservedTopLevelKey } from '../services/FieldTemplateService';
import { CHARACTER_CATEGORIES } from '../models/Character';

// ═══════════════════════════════════════════════════════
//  Add / Edit Universal Field Modal
// ═══════════════════════════════════════════════════════

/**
 * Modal to create or edit a universal field template.
 * Opens when the user clicks the '+' button in a section header.
 */
export class AddFieldModal extends Modal {
    private existing: UniversalFieldTemplate | null;
    private onSubmit: (template: UniversalFieldTemplate, positionAfterId?: string | null) => void;
    private onDelete?: () => void;
    private customSectionNames?: string[];
    /** Issue #92 — siblings (same section + category) used to populate the Position dropdown */
    private siblings: Array<{ id: string; label: string }> = [];
    /** Issue #92 — selected position: undefined = at end (default), null = at top, string = after that sibling id */
    private positionAfterId: string | null | undefined = undefined;

    // Working state
    private label = '';
    private labelInput: HTMLInputElement | null = null;
    private type: UniversalFieldType = 'text';
    private section = '';
    private placeholder = '';
    private options: string[] = [];
    private folderSource = '';
    private topLevelKey = '';
    private topLevelKeyTouched = false;
    private defaultValue = '';
    private computeFunction: ComputeFunction = 'average';
    private computeSourceIds: string[] = [];
    /** All templates in same category — used for computed field source picker */
    private allTemplates: UniversalFieldTemplate[] = [];

    /**
     * @param app            Obsidian App
     * @param defaultSection The section title to pre-select (e.g. 'Basic Information')
     * @param existing       If editing, the existing template; null for new
     * @param onSubmit       Called when the user confirms
     * @param onDelete       Called when the user clicks Delete (edit mode only)
     * @param sectionNames   Optional override for section dropdown (e.g. Codex categories)
     */
    constructor(
        app: App,
        defaultSection: string,
        existing: UniversalFieldTemplate | null,
        onSubmit: (template: UniversalFieldTemplate, positionAfterId?: string | null) => void,
        onDelete?: () => void,
        sectionNames?: string[],
        siblings?: Array<{ id: string; label: string }>,
        allTemplates?: UniversalFieldTemplate[],
    ) {
        super(app);
        this.existing = existing;
        this.onSubmit = onSubmit;
        this.onDelete = onDelete;
        this.customSectionNames = sectionNames;
        this.siblings = (siblings || []).filter(s => !existing || s.id !== existing.id);
        this.allTemplates = (allTemplates || []).filter(t => t.type !== 'computed');

        if (existing) {
            this.label = existing.label;
            this.type = existing.type;
            this.section = existing.section;
            this.placeholder = existing.placeholder;
            this.options = [...existing.options];
            this.folderSource = existing.folderSource ?? '';
            this.topLevelKey = existing.topLevelKey ?? '';
            this.topLevelKeyTouched = !!existing.topLevelKey;
            this.defaultValue = existing.defaultValue ?? '';
            this.computeFunction = existing.computeFunction ?? 'average';
            this.computeSourceIds = [...(existing.computeSourceIds ?? [])];
        } else {
            this.section = defaultSection;
        }
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('storyline-add-field-modal');

        contentEl.createEl('h3', {
            text: this.existing ? 'Edit Universal Field' : 'Add Universal Field',
        });

        const sheetLabel = this.customSectionNames ? 'entry' : 'character sheet';
        contentEl.createEl('p', {
            cls: 'storyline-add-field-desc',
            text: `This field will appear on every ${sheetLabel} in the chosen section.`,
        });

        // ── Label ──
        let topLevelKeyInput: HTMLInputElement | null = null;
        new Setting(contentEl)
            .setName('Field label')
            .setDesc('The name shown next to the input')
            .addText(text => {
                text.setPlaceholder('e.g. Species')
                    .setValue(this.label)
                    .onChange(v => {
                        this.label = v.trim();
                        if (!this.topLevelKeyTouched && topLevelKeyInput) {
                            this.topLevelKey = suggestTopLevelKey(this.label);
                            topLevelKeyInput.value = this.topLevelKey;
                        }
                    });
                this.labelInput = text.inputEl;
                text.inputEl.focus();
            });

        // ── Section ──
        const sectionNames = this.customSectionNames || CHARACTER_CATEGORIES.map(c => c.title);
        new Setting(contentEl)
            .setName('Section')
            .setDesc(`Where this field appears on the ${sheetLabel}`)
            .addDropdown(dd => {
                for (const name of sectionNames) {
                    dd.addOption(name, name);
                }
                dd.setValue(this.section || sectionNames[0]);
                dd.onChange(v => { this.section = v; });
            });

        // ── Type ──
        let optionsContainer: HTMLElement | null = null;
        let folderSourceContainer: HTMLElement | null = null;
        let computeContainer: HTMLElement | null = null;
        new Setting(contentEl)
            .setName('Input type')
            .addDropdown(dd => {
                dd.addOption('text', 'Text (single line)');
                dd.addOption('textarea', 'Text block (multi-line)');
                dd.addOption('dropdown', 'Dropdown menu');
                dd.addOption('multi-select', 'Multi-select (tags)');
                dd.addOption('checkbox', 'Checkbox (yes/no)');
                dd.addOption('computed', 'Computed / Derived (read-only)');
                dd.setValue(this.type);
                dd.onChange(v => {
                    this.type = v as UniversalFieldType;
                    const showOpts = this.type === 'dropdown' || this.type === 'multi-select';
                    if (optionsContainer) {
                        optionsContainer.setCssStyles({ display: showOpts ? '' : 'none' });
                    }
                    if (folderSourceContainer) {
                        const showFolderSrc = this.type === 'multi-select' || this.type === 'dropdown';
                        folderSourceContainer.setCssStyles({ display: showFolderSrc ? '' : 'none' });
                    }
                    if (computeContainer) {
                        computeContainer.setCssStyles({ display: this.type === 'computed' ? '' : 'none' });
                    }
                });
            });

        // ── Placeholder ──
        new Setting(contentEl)
            .setName('Placeholder')
            .setDesc('Hint text shown when the field is empty')
            .addText(text => {
                text.setPlaceholder('e.g. Human, Elf, Dwarf…')
                    .setValue(this.placeholder)
                    .onChange(v => { this.placeholder = v; });
            });

        // ── Dropdown options ──
        optionsContainer = contentEl.createDiv('storyline-field-options-container');
        if (this.type !== 'dropdown' && this.type !== 'multi-select') optionsContainer.setCssStyles({ display: 'none' });

        const optionsLabel = optionsContainer.createEl('div', {
            cls: 'setting-item-name',
            text: 'Dropdown options',
        });
        optionsLabel.setCssStyles({ marginBottom: '4px' });

        const optionsList = optionsContainer.createDiv('storyline-field-options-list');
        const renderOptions = () => {
            optionsList.empty();
            for (let i = 0; i < this.options.length; i++) {
                const row = optionsList.createDiv('storyline-field-option-row');
                const input = row.createEl('input', {
                    cls: 'storyline-field-option-input',
                    type: 'text',
                    attr: { placeholder: `Option ${i + 1}` },
                });
                input.value = this.options[i];
                input.addEventListener('input', () => {
                    this.options[i] = input.value;
                });

                const removeBtn = row.createEl('button', {
                    cls: 'storyline-field-option-remove',
                    text: '×',
                    attr: { title: 'Remove option' },
                });
                removeBtn.addEventListener('click', () => {
                    this.options.splice(i, 1);
                    renderOptions();
                });
            }
        };
        renderOptions();

        const addOptBtn = optionsContainer.createEl('button', {
            cls: 'storyline-field-option-add',
            text: '+ Add option',
        });
        addOptBtn.addEventListener('click', () => {
            this.options.push('');
            renderOptions();
            // Focus the new input
            const inputs = optionsList.querySelectorAll('input');
            if (inputs.length) inputs[inputs.length - 1].focus();
        });

        // ── Folder source (dropdown / multi-select) ──
        folderSourceContainer = contentEl.createDiv('storyline-field-folder-source-container');
        if (this.type !== 'multi-select' && this.type !== 'dropdown') folderSourceContainer.setCssStyles({ display: 'none' });
        new Setting(folderSourceContainer)
            .setName('Folder source (optional)')
            .setDesc('Vault folder path whose note names become selectable options (e.g. Traits/)')
            .addText(text => {
                text.setPlaceholder('e.g. World/Traits')
                    .setValue(this.folderSource)
                    .onChange(v => { this.folderSource = v.trim(); });
            });

        // ── Computed field config ──
        computeContainer = contentEl.createDiv('storyline-field-compute-container');
        if (this.type !== 'computed') computeContainer.setCssStyles({ display: 'none' });

        new Setting(computeContainer)
            .setName('Function')
            .setDesc('How to aggregate the source field values')
            .addDropdown(dd => {
                dd.addOption('average', 'Average');
                dd.addOption('sum', 'Sum');
                dd.addOption('max', 'Maximum');
                dd.addOption('min', 'Minimum');
                dd.addOption('count-truthy', 'Count truthy');
                dd.addOption('count-falsy', 'Count falsy');
                dd.setValue(this.computeFunction);
                dd.onChange(v => { this.computeFunction = v as ComputeFunction; });
            });

        const sourceFieldsContainer = computeContainer.createDiv('storyline-field-compute-sources');
        const sourceLabel = sourceFieldsContainer.createEl('div', {
            cls: 'setting-item-name',
            text: 'Source fields',
        });
        sourceLabel.setCssStyles({ marginBottom: '4px' });
        const sourceDesc = sourceFieldsContainer.createEl('div', {
            cls: 'setting-item-description',
            text: 'Select which fields to include in the computation',
        });
        sourceDesc.setCssStyles({ marginBottom: '8px' });
        const sourceList = sourceFieldsContainer.createDiv('storyline-field-compute-source-list');
        for (const tpl of this.allTemplates) {
            if (this.existing && tpl.id === this.existing.id) continue;
            const row = sourceList.createDiv('storyline-field-compute-source-row');
            const cb = row.createEl('input', { type: 'checkbox', attr: { id: `src-${tpl.id}` } });
            cb.checked = this.computeSourceIds.includes(tpl.id);
            cb.addEventListener('change', () => {
                if (cb.checked && !this.computeSourceIds.includes(tpl.id)) {
                    this.computeSourceIds.push(tpl.id);
                } else if (!cb.checked) {
                    this.computeSourceIds = this.computeSourceIds.filter(id => id !== tpl.id);
                }
            });
            row.createEl('label', { text: `${tpl.label} (${tpl.section})`, attr: { for: `src-${tpl.id}` } });
        }
        if (this.allTemplates.length === 0) {
            sourceList.createEl('em', { text: 'No other fields available. Add fields first, then create a computed field.' });
        }

        // ── Top-level YAML key (issue #71) ──
        new Setting(contentEl)
            .setName('Top-level YAML key (optional)')
            .setDesc('When set, this field\'s value is also written as a top-level YAML key so it appears in Obsidian Properties / Bases / Dataview. Leave blank to keep it inside `universalFields:` only. Reserved StoryLine keys are not allowed.')
            .addText(text => {
                text.setPlaceholder(suggestTopLevelKey(this.label || 'field'))
                    .setValue(this.topLevelKey)
                    .onChange(v => {
                        this.topLevelKey = v.trim();
                        this.topLevelKeyTouched = true;
                    });
                topLevelKeyInput = text.inputEl;
            });

        // ── Default value (issue #77) ──
        new Setting(contentEl)
            .setName('Default value (optional)')
            .setDesc('Pre-fill this field on newly-created entities (currently applied to scenes). For multi-select fields, separate values with commas.')
            .addText(text => {
                text.setPlaceholder('e.g. Draft, fountain, Setup')
                    .setValue(this.defaultValue)
                    .onChange(v => { this.defaultValue = v; });
            });

        // ── Position (issue #92) ──
        if (this.siblings.length > 0) {
            new Setting(contentEl)
                .setName('Position')
                .setDesc('Where the field appears in the section')
                .addDropdown(dd => {
                    dd.addOption('__end__', 'At end (default)');
                    dd.addOption('__top__', 'At top');
                    for (const s of this.siblings) {
                        dd.addOption(s.id, `After: ${s.label}`);
                    }
                    dd.setValue('__end__');
                    dd.onChange(v => {
                        if (v === '__end__') this.positionAfterId = undefined;
                        else if (v === '__top__') this.positionAfterId = null;
                        else this.positionAfterId = v;
                    });
                });
        }

        // ── Action buttons ──
        const footer = contentEl.createDiv('storyline-add-field-footer');

        if (this.existing && this.onDelete) {
            const deleteBtn = footer.createEl('button', {
                cls: 'mod-warning storyline-field-delete-btn',
                text: 'Delete field',
            });
            deleteBtn.addEventListener('click', () => {
                this.onDelete!();
                this.close();
            });
        }


        const cancelBtn = footer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = footer.createEl('button', {
            cls: 'mod-cta',
            text: this.existing ? 'Save' : 'Add field',
        });
        confirmBtn.addEventListener('click', () => {
            // Read input value directly in case onChange hasn't fired yet (issue #115)
            if (this.labelInput) {
                const raw = this.labelInput.value.trim();
                if (raw) this.label = raw;
            }
            if (!this.label) {
                // Highlight label field
                const labelInput = contentEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
                if (labelInput) {
                    labelInput.addClass('is-invalid');
                    labelInput.focus();
                }
                return;
            }

            // Filter empty options
            const cleanOptions = this.options.map(o => o.trim()).filter(Boolean);

            const tlk = this.topLevelKey.trim();
            if (tlk) {
                if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tlk)) {
                    new Notice('Top-level YAML key must start with a letter and use only letters, numbers, or underscores.');
                    return;
                }
                if (isReservedTopLevelKey(tlk)) {
                    new Notice(`"${tlk}" is reserved by StoryLine. Choose a different key.`);
                    return;
                }
            }

            const template: UniversalFieldTemplate = {
                id: this.existing?.id ?? generateId(),
                label: this.label,
                section: this.section || CHARACTER_CATEGORIES[0].title,
                category: this.existing?.category,
                type: this.type,
                options: (this.type === 'dropdown' || this.type === 'multi-select') ? cleanOptions : [],
                folderSource: (this.type === 'multi-select' || this.type === 'dropdown') && this.folderSource ? this.folderSource : undefined,
                placeholder: this.placeholder,
                topLevelKey: tlk || undefined,
                defaultValue: this.defaultValue.trim() ? this.defaultValue.trim() : undefined,
                computeFunction: this.type === 'computed' ? this.computeFunction : undefined,
                computeSourceIds: this.type === 'computed' && this.computeSourceIds.length ? [...this.computeSourceIds] : undefined,
                order: this.existing?.order ?? Date.now(),
            };

            this.onSubmit(template, this.positionAfterId);
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
