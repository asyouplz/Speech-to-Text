/** DOM extensions supplied by Obsidian in production. */
function installObsidianDom(win) {
    const create = (doc, tag, options = {}, namespace) => {
        const el = namespace ? doc.createElementNS(namespace, tag) : doc.createElement(tag);
        const info = typeof options === 'string' ? { cls: options } : options;
        if (info.cls)
            el.setAttribute('class', Array.isArray(info.cls) ? info.cls.join(' ') : info.cls);
        if (info.text !== undefined) el.textContent = info.text;
        for (const [key, value] of Object.entries(info.attr || {})) el.setAttribute(key, value);
        return el;
    };
    win.createEl = (tag, options) => create(win.document, tag, options);
    win.createDiv = (options) => win.createEl('div', options);
    win.createSpan = (options) => win.createEl('span', options);
    win.createSvg = (tag, options) =>
        create(win.document, tag, options, 'http://www.w3.org/2000/svg');
    Object.assign(win.Node.prototype, {
        empty() {
            this.replaceChildren();
        },
        createEl(tag, options) {
            const el = create(this.ownerDocument, tag, options);
            this.appendChild(el);
            return el;
        },
        createDiv(options) {
            return this.createEl('div', options);
        },
        createSpan(options) {
            return this.createEl('span', options);
        },
        addClass(...names) {
            this.classList.add(...names);
        },
        removeClass(...names) {
            this.classList.remove(...names);
        },
        setText(text) {
            this.textContent = text;
        },
        instanceOf(type) {
            const owner = this.ownerDocument?.defaultView || win;
            return this instanceof owner[type.name];
        },
    });
}
module.exports = { installObsidianDom };
