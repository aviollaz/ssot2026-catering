import type {EntityNamesResponse} from '../backend/browser-contract.js';
import {element} from './dom.js';
import {cerrada, porArea} from './menu.js';
import {observeSheetLayout} from './sheet-layout.js';

export function createTableNavigation(select: (name: string) => void) {
    const toggle = document.querySelector<HTMLButtonElement>('#open-tables')!;
    const panel = document.querySelector<HTMLDialogElement>('#tables-panel')!;
    const search = document.querySelector<HTMLInputElement>('#table-search')!;
    const list = document.querySelector<HTMLElement>('#table-list')!;
    const layout = observeSheetLayout(panel, toggle);
    const buttons = () => [...list.querySelectorAll<HTMLButtonElement>('button[data-entity]')];
    toggle.onclick = () => { panel.showModal(); toggle.setAttribute('aria-expanded', 'true'); };
    document.querySelector<HTMLButtonElement>('#close-tables')!.onclick = () => panel.close();
    panel.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
    // While searching, areas with matches open and empty ones hide; clearing the search restores them.
    search.oninput = () => {
        const filter = search.value.trim().toLocaleLowerCase();
        for (const button of buttons()) button.hidden = !button.textContent!.toLocaleLowerCase().includes(filter);
        for (const group of [...list.querySelectorAll<HTMLDetailsElement>('details')].reverse()) {
            const matches = [...group.querySelectorAll<HTMLButtonElement>('button[data-entity]')].some(button => !button.hidden);
            group.hidden = !matches;
            group.open = filter ? matches : group.dataset['abierto'] === 'true';
        }
        layout();
    };
    return {
        catalog(entries: EntityNamesResponse) {
            toggle.hidden = entries.length === 0;
            search.value = '';
            panel.close();
            // One <details> per area; "Area/Subarea" nests inside its parent area.
            const groups = new Map<string, HTMLDetailsElement>();
            const group = (path: string): HTMLDetailsElement => {
                const existing = groups.get(path);
                if (existing) return existing;
                const details = element('details');
                details.className = 'menu-group';
                details.open = !cerrada(path);
                details.dataset['abierto'] = String(details.open);
                details.addEventListener('toggle', layout);
                details.append(element('summary', path.slice(path.lastIndexOf('/') + 1)));
                groups.set(path, details);
                if (path.includes('/')) group(path.slice(0, path.lastIndexOf('/'))).append(details);
                return details;
            };
            for (const [area, items] of porArea(entries)) {
                group(area).append(...items.map(({name, label}) => {
                    const button = element('button', label);
                    button.type = 'button';
                    button.dataset['entity'] = name;
                    button.onclick = () => select(name);
                    return button;
                }));
            }
            list.replaceChildren(...[...groups].filter(([path]) => !path.includes('/')).map(([, details]) => details));
            layout();
        },
        activate(name: string) {
            for (const button of buttons()) {
                const current = button.dataset['entity'] === name;
                button.setAttribute('aria-current', String(current));
                // The current sheet stays visible even inside an area closed by default.
                if (current) for (let group = button.closest('details'); group; group = group.parentElement!.closest('details')) group.open = true;
            }
            if (panel.matches(':modal')) panel.close();
            layout();
        },
    };
}
