Token budget (your tokens come out of a usage window shared with other workers):
- Search (grep/rg) before reading; read long files in line ranges, not whole.
- Keep command output short: `| tail -n 40`, quiet flags (`-q`, `--silent`), no full logs or dumps.
- Run only the tests your change touches; the full suite once at the end if the brief asks for it.
- Don't re-read files you just wrote or re-run a command whose result you already have.
