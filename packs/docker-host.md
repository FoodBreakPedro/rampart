---
name: docker-host
version: 1.0.0
appliesTo:
  - docker-host
  - supabase
  - n8n
kinds:
  - host
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://docs.docker.com/engine/security/ | 2026-10-23
  - https://docs.docker.com/engine/network/packet-filtering-firewalls/ | 2026-10-23
  - https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html | 2026-10-23
  - https://www.cisecurity.org/benchmark/docker | 2026-10-23
  - https://man.openbsd.org/sshd_config | 2026-10-23
  - https://ubuntu.com/server/docs/how-to/software/automatic-updates/ | 2026-10-23
  - https://trivy.dev/latest/docs/target/container_image/ | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Host pack for a Linux machine that runs containers with Docker Engine. It also applies to supabase and n8n systems, whose
     inventory pairs their own pack with this one. The infra-prober compares the probe observations with the Baseline and writes
     candidates; verifiers try to disprove each one from the same observations. Say "unavailable" rather than "clean" when a
     probe could not run: two probes (container-hostconfig, sshd-effective) need root and report permission errors for an
     ordinary SSH user, and docker probes need the SSH user in the docker group. When the system has no ssh target the runner
     executes these commands on this machine. -->

# Docker host

## Hunt classes

### exposed-ports: Container ports published to every interface

**Look for:** containers lines whose port mapping binds all interfaces (`0.0.0.0:<port>->` or `[::]:<port>->`) for a service that is not meant to be public: databases (5432, 3306, 6379, 27017), admin UIs, internal APIs, metrics. Docker inserts its own packet-filter rules for published ports ahead of the host firewall, so `ufw` rules do not filter them: an active firewall in firewall-units or ufw-enabled is not a defence for a published port. listening-ports shows the host-level picture: services outside Docker listening on `0.0.0.0` or `[::]` that the firewall observations do not cover.
**Confirm by:** Quote the mapping with the container name and image, name the service behind it and what an outside caller can do with it (a login prompt, an unauthenticated API, a database protocol). For a non-Docker listener, quote the listening-ports line and show no firewall observation covers it.
**Disprove by:** The port is bound to a loopback address or a specific private interface address, or not published; the service is the intended public entry point (a reverse proxy on 80 or 443, the system's gateway); the listener is SSH. A firewall observation does not disprove a Docker-published port, for the reason above.
**Severity when confirmed:** HIGH. A database or internal service is reachable from any network that reaches the host. MEDIUM when the service enforces its own strong authentication and holds no data; LOW for a metrics or health endpoint with no sensitive detail.
**CWE:** CWE-668, CWE-284

### container-privileges: Containers that can take over the host

**Look for:** In container-hostconfig: `"Privileged":true`, `"PidMode":"host"`, `"IpcMode":"host"`, `"UsernsMode":"host"`, `"CapAdd"` naming `SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, `SYS_MODULE` or `ALL`, and `"Devices"` passing host devices. In container-mounts: `/var/run/docker.sock` or `/run/docker.sock` mounted into a container (control of the Docker daemon is root on the host), or host paths such as `/`, `/etc`, `/root`, `/home` mounted in; `host` in the networks column. Map each container ID in container-hostconfig to its name with the containers observation.
**Confirm by:** Name the container, image and the exact flag or mount, and the escape it allows: privileged mode or `SYS_ADMIN` mounts the host disk; the Docker socket starts a privileged container; a host `/` mount writes to host files. Say whether the container also runs a network-facing service (the containers observation shows its published port), since that makes the escape remotely reachable.
**Disprove by:** container-hostconfig shows none of the flags and container-mounts shows only named volumes or data directories. A socket mount on a container whose image is a Docker management tool the owner runs on purpose (a socket proxy that exposes only read endpoints) lowers it; permission errors in container-hostconfig mean that part is unavailable, not clean.
**Severity when confirmed:** HIGH. A compromise of the container is a compromise of the host. CRITICAL when the container also serves an unauthenticated or internet-facing interface; MEDIUM for a single added capability without a known escape (for example only `NET_ADMIN`).
**CWE:** CWE-250, CWE-269

### daemon-exposure: Docker API reachable over the network

**Look for:** daemon-config with `"hosts"` naming `tcp://` (especially `tcp://0.0.0.0:2375`) without `"tlsverify": true` and TLS certificate paths; listening-ports showing 2375 or 2376 on `0.0.0.0` or `[::]`. The Docker API grants root on the host to anyone who can call it. Also note in docker-engine's security options whether the daemon runs rootless (`name=rootless`) or with user namespaces (`name=userns`), which lower the impact.
**Confirm by:** Quote the `hosts` entry and the listening line, and the absence of `tlsverify` in daemon-config.
**Disprove by:** No TCP host in daemon-config and nothing on 2375/2376; or TCP with `tlsverify` and client certificates; or the listener is bound to a loopback address only. A missing daemon.json (`No such file`) means the default unix socket only.
**Severity when confirmed:** CRITICAL. Anyone who reaches the port controls the host. HIGH when the port is bound to a private interface only; MEDIUM with TLS but no client verification evidence.
**CWE:** CWE-306, CWE-284

### ssh-auth: SSH accepts passwords or root logins

**Look for:** sshd-effective (when it ran as root) or sshd-config-files: `passwordauthentication yes`, `kbdinteractiveauthentication yes` or `challengeresponseauthentication yes` (password guessing over SSH), `permitrootlogin yes` (root by password), `permitemptypasswords yes`. In sshd-config-files, remember that the first value OpenSSH reads wins and that `Include /etc/ssh/sshd_config.d/*.conf` sits at the top of Debian and Ubuntu configs, so a drop-in such as `50-cloud-init.conf` setting `PasswordAuthentication yes` overrides a later `no`; `Match` blocks can re-enable passwords for some users or addresses.
**Confirm by:** Quote the effective line from sshd-effective, or the file and line from sshd-config-files with the ordering argument above, and say who can try: any address that reaches port 22 (listening-ports shows sshd on all interfaces).
**Disprove by:** sshd-effective prints `passwordauthentication no`, `kbdinteractiveauthentication no` and `permitrootlogin` `no` or `prohibit-password`; or the files show only those values with no earlier override; or `AuthenticationMethods publickey` is set. If sshd-effective failed with a permission or host-key error and sshd-config-files could not read a drop-in, the effective value is unknown: say unsure. A non-default port, no fail2ban and `PubkeyAuthentication` with RSA keys are hardening.
**Severity when confirmed:** MEDIUM. Passwords can be guessed against SSH. HIGH when root may log in with a password or empty passwords are permitted; LOW when sshd listens only on a private interface address.
**CWE:** CWE-307, CWE-287, CWE-521

### host-firewall: No host firewall in front of listening services

**Look for:** firewall-units showing `ufw`, `firewalld` and `nftables` all inactive (or ufw-enabled showing `ENABLED=no`) while listening-ports shows services outside Docker on all interfaces besides SSH (a database installed on the host, a web admin panel, Redis). Docker-published ports are exposed-ports' concern, not this class.
**Confirm by:** Quote the firewall states and the listening line, and name the service if the port is a well-known one.
**Disprove by:** A firewall is active (`active` in firewall-units, `ENABLED=yes`), or nothing but SSH and the intended public ports (80, 443) listens on all interfaces, or the extra listeners are bound to loopback. No firewall on a host whose only listeners are SSH and a reverse proxy is hardening.
**Severity when confirmed:** MEDIUM. A host service is reachable from any network that reaches the machine. HIGH when the listener is a database or admin service without its own authentication.
**CWE:** CWE-284, CWE-668

### patching: Operating system and engine updates not applied automatically

**Look for:** auto-upgrades-unit not `enabled` for `unattended-upgrades.service` (Debian, Ubuntu) or a `dnf-automatic` timer (Fedora, RHEL family); auto-upgrades-config missing or with `APT::Periodic::Unattended-Upgrade "0"`; os-release naming a release past its vendor's end of standard support; docker-engine's server version or kernel's version in a range named by a vendor advisory (Docker Engine, containerd, runc, Linux kernel container escapes).
**Confirm by:** Quote the unit state or config line, the release and its end-of-support date, or the version with the advisory (id or title) and the first fixed version.
**Disprove by:** Automatic security updates are enabled and the config line is `"1"`; the release is supported; the engine and kernel are at or after the fixed versions. Updates managed another way (a configuration-management run the owner documents) disprove the unattended-upgrades part. Automatic updates off on a supported, current host is hardening.
**Severity when confirmed:** MEDIUM. Known vulnerabilities stay open on the host. HIGH for an unpatched container-escape or remote advisory in the running engine or kernel; LOW when only the automatic update setting is off on a current release.
**CWE:** CWE-1104, CWE-1395

### outdated-images: Container images with known vulnerabilities

**Look for:** containers and image-digests: images on `latest` or untagged, images whose tag or creation date predates a vendor advisory's fix, and images from abandoned repositories. trivy-present shows whether Trivy is installed (with its vulnerability database date); the probes do not run a per-image scan, because the image names are not known in advance, so Trivy results count only when the run includes them as an extra observation.
**Confirm by:** Name the container, image and tag or digest date, and the advisory with its fixed version, or the Trivy result line (CVE, package, installed and fixed version) for that image. Say whether the vulnerable component is reachable: the container's published port or its role.
**Disprove by:** The image is at or after the fixed version, or the vulnerable package is not used at runtime (a Trivy hit in a build tool the service never runs). An old image with no known vulnerability, or `latest` with a recent creation date, is hardening.
**Severity when confirmed:** HIGH. A known vulnerability sits in a component the container exposes; follow the advisory's own rating when it is higher or lower, and cap it at MEDIUM when the container publishes no port and takes no outside input.
**CWE:** CWE-1395, CWE-1104

## Baseline

A healthy Docker host publishes only its intended public entry points (a reverse proxy on 80 and 443, or the system's gateway) to all interfaces; everything else is unpublished or bound to a loopback address, since published ports bypass `ufw`. No container runs privileged, shares the host's PID, IPC or user namespaces, adds dangerous capabilities, or mounts the Docker socket or host system paths. The Docker API listens only on its unix socket, or on TCP with mutual TLS. SSH accepts keys only and refuses root passwords; the effective configuration, drop-ins included, says so. A host firewall is active for non-Docker services. The release is supported, unattended security upgrades (or the distribution's equivalent) are enabled, and Docker Engine, containerd, runc and the kernel are past every container-escape fix. Images carry version tags and are rebuilt or pulled after vendor security releases.

## Probes

### containers: Running containers, images and published ports

**via:** `ssh`
**argv:** `["docker","ps","--no-trunc","--format","{{.ID}} {{.Names}} {{.Image}} {{.Ports}}"]`
**expect:** One line per running container: full ID, name, image with tag, port mappings. Healthy: mappings to all interfaces (`0.0.0.0:` or `[::]:`) only for the public entry points; other mappings on a loopback address or absent. `permission denied` on the Docker socket means the SSH user is not in the docker group: unavailable.
**scrub:** none

### container-mounts: Mounts and networks per container

**via:** `ssh`
**argv:** `["docker","ps","--no-trunc","--format","{{.Names}} {{.Networks}} {{.Mounts}}"]`
**expect:** Name, networks and mounts (volume names, or host paths for bind mounts). Healthy: named volumes or application data paths; no `/var/run/docker.sock` or `/run/docker.sock`, no `/`, `/etc`, `/root` or `/home` host paths; no `host` network unless the owner runs a network tool on purpose.
**scrub:** none

### image-digests: Local images, digests and creation dates

**via:** `ssh`
**argv:** `["docker","image","ls","--digests","--format","{{.Repository}}:{{.Tag}} {{.Digest}} {{.CreatedAt}}"]`
**expect:** One line per local image with tag, digest and creation date. Healthy: version tags on the images the running containers use and creation dates after the latest vendor security release for each.
**scrub:** none

### container-hostconfig: Privilege flags of every container (needs root)

**via:** `ssh`
**argv:** `["grep","-r","-o","--include=hostconfig.json","-e","\"Privileged\":true","-e","\"PidMode\":\"host\"","-e","\"IpcMode\":\"host\"","-e","\"UsernsMode\":\"host\"","-e","\"NetworkMode\":\"host\"","-e","\"CapAdd\":\\[[^]]*]","-e","\"Devices\":\\[[^]]*]","/var/lib/docker/containers"]`
**expect:** As root: one `<container dir>/hostconfig.json:<flag>` line per risky flag, and healthy output is empty or only `"CapAdd":[]` / `"Devices":[]`. Only these keys are printed, never environment or log options. As an ordinary user the command fails with `Permission denied` (the Docker data directory is root-only): unavailable, not clean. Rootless Docker keeps containers under the user's home instead, so the path is missing.
**scrub:** env

### daemon-config: Docker daemon configuration

**via:** `ssh`
**argv:** `["cat","/etc/docker/daemon.json"]`
**expect:** The daemon's JSON settings, or `No such file or directory` (defaults: unix socket only). Healthy: no `hosts` entry with `tcp://`, or one with `"tlsverify": true` and certificate paths; `"userns-remap"` or `"no-new-privileges": true` are good signs.
**scrub:** env

### docker-engine: Docker Engine version and security options

**via:** `ssh`
**argv:** `["docker","info","--format","{{.ServerVersion}} {{.CgroupVersion}} {{.SecurityOptions}}"]`
**expect:** One line: engine version, cgroup version and security options such as `[name=apparmor name=seccomp,profile=builtin name=cgroupns]`. Healthy: a supported engine version past known runc and containerd escape fixes, seccomp present; `name=rootless` or `name=userns` lower container-escape impact.
**scrub:** none

### listening-ports: TCP listeners on the host

**via:** `ssh`
**argv:** `["ss","-tln"]`
**expect:** Listening TCP sockets with local addresses. Healthy: SSH (22 or the owner's port) and the public entry points on all interfaces; databases and admin services on a loopback address only; nothing on 2375 or 2376. Docker-published ports also appear here (as the docker-proxy listener). Process names are not shown, which needs root.
**scrub:** none

### sshd-effective: Effective SSH server settings (needs root)

**via:** `ssh`
**argv:** `["sshd","-T"]`
**expect:** As root: the effective settings in lowercase, including `passwordauthentication no`, `kbdinteractiveauthentication no`, `permitrootlogin no` or `prohibit-password`, `permitemptypasswords no`. As an ordinary user sshd cannot read the host keys and exits with a permission or host-key error: unavailable; use sshd-config-files.
**scrub:** none

### sshd-config-files: SSH authentication lines in the config files

**via:** `ssh`
**argv:** `["grep","-r","-H","-i","-e","^[[:space:]]*PasswordAuthentication","-e","^[[:space:]]*KbdInteractiveAuthentication","-e","^[[:space:]]*ChallengeResponseAuthentication","-e","^[[:space:]]*PermitRootLogin","-e","^[[:space:]]*PermitEmptyPasswords","-e","^[[:space:]]*AuthenticationMethods","-e","^[[:space:]]*Include","-e","^[[:space:]]*Match","/etc/ssh/sshd_config","/etc/ssh/sshd_config.d"]`
**expect:** `file:line` for each authentication setting, `Include` and `Match`. Healthy: the first value read for `PasswordAuthentication` and `KbdInteractiveAuthentication` is `no` and `PermitRootLogin` is `no` or `prohibit-password`, counting drop-ins in `sshd_config.d` that an `Include` near the top reads first. `Permission denied` on a drop-in means that file's value is unknown.
**scrub:** env

### firewall-units: Host firewall services

**via:** `ssh`
**argv:** `["systemctl","is-active","ufw","firewalld","nftables"]`
**expect:** One state per unit, in order. Healthy: at least one `active`. For ufw, the unit can be active while the firewall is disabled, so read ufw-enabled too; an `active` nftables unit with an empty ruleset filters nothing.
**scrub:** none

### ufw-enabled: ufw enabled at boot

**via:** `ssh`
**argv:** `["grep","-H","^ENABLED=","/etc/ufw/ufw.conf"]`
**expect:** `/etc/ufw/ufw.conf:ENABLED=yes` when ufw is the host's firewall; `ENABLED=no` means ufw is off; `No such file` means ufw is not installed (another firewall may be in use).
**scrub:** none

### auto-upgrades-unit: Automatic security update service

**via:** `ssh`
**argv:** `["systemctl","is-enabled","unattended-upgrades.service","dnf-automatic.timer","dnf-automatic-install.timer"]`
**expect:** `enabled` for the distribution's mechanism (`unattended-upgrades.service` on Debian and Ubuntu, a `dnf-automatic` timer on Fedora and the RHEL family); a "no such file" error for the other units is normal.
**scrub:** none

### auto-upgrades-config: APT periodic upgrade settings

**via:** `ssh`
**argv:** `["cat","/etc/apt/apt.conf.d/20auto-upgrades"]`
**expect:** `APT::Periodic::Update-Package-Lists "1";` and `APT::Periodic::Unattended-Upgrade "1";`. A `"0"` disables automatic upgrades; `No such file` on a Debian or Ubuntu host means they were never enabled (not applicable on other distributions).
**scrub:** none

### os-release: Distribution and release

**via:** `ssh`
**argv:** `["cat","/etc/os-release"]`
**expect:** The distribution name and `VERSION_ID`. Healthy: a release inside its vendor's standard or extended support window.
**scrub:** none

### kernel: Kernel release

**via:** `ssh`
**argv:** `["uname","-sr"]`
**expect:** `Linux <release>`. Healthy: a release past the fixes for container-escape advisories that affect the distribution's kernel line.
**scrub:** none

### trivy-present: Trivy installed for image scans

**via:** `ssh`
**argv:** `["trivy","--version"]`
**expect:** Trivy's version and, when its database is present, the vulnerability database date. `command not found` is normal when Trivy is not installed; it only tells the prober whether per-image scan results could be added to the run.
**scrub:** none

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://docs.docker.com/engine/security/ (2026-10-23)
- https://docs.docker.com/engine/network/packet-filtering-firewalls/ (2026-10-23)
- https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html (2026-10-23)
- https://www.cisecurity.org/benchmark/docker (2026-10-23)
- https://man.openbsd.org/sshd_config (2026-10-23)
- https://ubuntu.com/server/docs/how-to/software/automatic-updates/ (2026-10-23)
- https://trivy.dev/latest/docs/target/container_image/ (2026-10-23)
