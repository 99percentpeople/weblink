# Device pairing and permissions

Pairing verifies which device is connected; permissions decide which features it may access. Display names, room passwords, and MCP tokens serve different purposes and are not interchangeable.

## First connection and reconnection {#pairing}

On the first connection, devices verify identity and save pairing records, usually without manual action. Later connections verify identity again before applying saved permissions.

Pairing belongs to the current browser or desktop profile and does not automatically sync through an account. After clearing site data, using a new profile, or changing computers, the other device may need to confirm the identity again. A matching name alone does not prove it is the original device.

## View and change device permissions {#permissions}

Open permissions from member details, or select a device in **Settings → Clients and rooms**. Permissions are saved locally per device, and each side independently decides what the other can do.

| Permission        | Controls                                                            | Default after first pairing                     |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| Receive content   | Application content from that device, such as messages and files    | Allowed                                         |
| Provide file list | Browsing files you explicitly share                                 | Allowed; does not share all files automatically |
| Share screen      | Providing screen content to that device                             | Allowed; does not start capture automatically   |
| Remote control    | Operating this computer's monitor                                   | Ask                                             |
| Automation groups | Reading and diagnostics, Sharing and control, Terminal and commands | Ask separately for each group                   |

Remote control and automation support **Ask, Always allow, and Deny** per device. Automation also requires the destination to support the requested feature; operating-system tools require automation to be enabled. See [MCP and automation](automation.md#permissions).

## Handle permission requests {#requests}

Review the requesting device and action before allowing or denying it. Automation requests can be allowed for the current session. Always allow or Always deny saves the policy for that device and permission group.

System notifications remind you or open the current approval request. Clicking a notification alone does not authorize access. After expiry, cancellation, or a disconnect, an old notification cannot approve the request; the other device needs to request it again.

## Identity changes and re-pairing {#repair}

An identity mismatch or untrusted warning stops protected content access and operations. First confirm whether the other person cleared data, changed profiles, or changed devices.

1. Keep both devices online and open that device's permissions.
2. Request re-pairing from one side.
3. On the other side, confirm that the current device is trusted and accept in the notification or permission page.
4. Wait for both sides to save, review permissions, and retry the action.

Pairing requests expire after about 60 seconds; retry after confirming both sides are online. Accepting re-pairing trusts the currently connected device and replaces the previous identity decision. It does not automatically prove that this is the old device. Review any allow policies you need after repair.

## Revoke access and disconnect {#revoke}

To stop allowing a feature, turn off its permission or choose Deny for the device. During sharing or control, also use the status controls to stop. See [Remote desktop](remote-control.md#permissions) for emergency stopping.

Ordinary disconnects end live access but generally keep saved permissions. The next connection still verifies identity. After identity verification fails, reconnecting or using the same display name does not restore authorization; complete explicit pairing repair first.

## Choose your next step {#troubleshooting}

- **Start controlling an authorized computer:** follow [remote-desktop setup](remote-control.md#connect).
- **Choose what AI tools may do on a device:** configure [automation permissions](automation.md#permissions).
- **Understand the proofs behind pairing and recovery:** explore [device identity and authorization](../architecture/device-trust.md).
- **Devices are paired but content still cannot connect:** follow the [WebRTC connection checks](faq.md#peer-connection).
