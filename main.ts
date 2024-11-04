import { MarkdownView, Plugin } from 'obsidian';

// Main plugin class
export default class DblpFetchPlugin extends Plugin {
    
    async onload() {

        // This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'fit-sigma-graph-to-view',
			name: 'Fit sigma graph to view',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (mdView) {
                    const mdfile = mdView.file;
					if (mdfile) {
						this.app.fileManager.processFrontMatter(mdfile);
						
					}

					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {

					}
					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});
    }

    async onunload() { }
}