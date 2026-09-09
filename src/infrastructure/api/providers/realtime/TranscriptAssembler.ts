interface Part {
    text: string;
    done: boolean;
    failed: boolean;
}

/** 커밋된 입력 순서를 먼저 등록하고, 도착 순서가 다른 결과를 해당 위치에 채운다. */
export class TranscriptAssembler {
    private order: string[] = [];
    private parts = new Map<string, Map<number, Part>>();

    register(id: string): void {
        if (!this.order.includes(id)) this.order.push(id);
        this.part(id, 0);
    }

    update(id: string, index: number, text: string, complete: boolean, failed = false): void {
        const part = this.part(id, index);
        if (part.done) return;
        if (!failed) part.text = complete ? text : part.text + text;
        part.done = complete;
        part.failed = failed;
    }

    private part(id: string, index: number): Part {
        let content = this.parts.get(id);
        if (!content) {
            content = new Map();
            this.parts.set(id, content);
        }
        let part = content.get(index);
        if (!part) {
            part = { text: '', done: false, failed: false };
            content.set(index, part);
        }
        return part;
    }

    get text(): string {
        const uncommitted = [...this.parts.keys()].filter((id) => !this.order.includes(id));
        return [...this.order, ...uncommitted]
            .flatMap((id) => [...(this.parts.get(id)?.entries() ?? [])].sort((a, b) => a[0] - b[0]))
            .map(([, part]) => part.text)
            .filter(Boolean)
            .join('\n\n');
    }

    get complete(): boolean {
        return (
            this.parts.size === this.order.length &&
            [...this.parts.values()].every((parts) =>
                [...parts.values()].every((part) => part.done && !part.failed)
            )
        );
    }
}
