# Security

## Trust model

- Own systems only: Rampart audits systems you own or are authorized to assess. Each project records an owner attestation, and agents refuse any target that is not in the inventory.
- No isolation layer: Rampart runs with the permissions of your Claude Code session and does not sandbox itself. Run it inside sandbox-runtime for anything you do not trust.
- Report issues via GitHub security advisories: report vulnerabilities in Rampart privately through the repository's Security tab, not in public issues.
