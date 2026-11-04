/* Light/dark theme. A plain script loaded in <head> (not a module, which would run later), so data-theme
   is set before the page paints. "auto" follows the computer's theme; the choice is remembered in this browser. */
(() => {
    const choices = ['auto', 'light', 'dark'];
    const labels = {auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: oscuro'};
    const key = 'catering-theme';
    const dark = matchMedia('(prefers-color-scheme: dark)');

    let choice = 'auto';
    try { choice = choices.includes(localStorage.getItem(key)) ? localStorage.getItem(key) : 'auto'; } catch { /* storage blocked */ }

    const apply = () => {
        document.documentElement.dataset.theme = choice === 'auto' ? (dark.matches ? 'dark' : 'light') : choice;
        const button = document.querySelector('#theme');
        if (button) button.textContent = labels[choice];
    };
    apply();
    dark.addEventListener('change', apply);

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.querySelector('#theme');
        if (!button) return;
        button.onclick = () => {
            choice = choices[(choices.indexOf(choice) + 1) % choices.length];
            try { localStorage.setItem(key, choice); } catch { /* not remembered, still applied */ }
            apply();
        };
        apply();
    });
})();
