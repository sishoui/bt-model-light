# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

## Triage roles

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Component / area labels

These labels describe **which part of the project a change touches**. Apply them **in addition to** the triage role labels above — not instead of them. A typical issue carries one triage role label plus one or more component labels.

| Label       | Use when the change touches                                  |
| ----------- | ----------------------------------------------------------- |
| `小程序`    | The WeChat / Mini Program client                            |
| `后台`      | The admin / backend management web app                      |
| `后端`      | The backend service / API server                            |
| `固件`      | Firmware / embedded code                                    |
| `数据库`    | Schema, migrations, queries, data fixes                     |
| `文档`      | Docs, README, guides, ADRs, glossary                        |

When filing or triaging an issue that names a concrete change, add the matching component label(s) in the same `gh issue create` / `gh issue edit` call. If a change spans multiple components, apply every relevant label.

Edit this section whenever a new area of the system is introduced; create the matching label on GitHub (`gh label create "<name>" --color "<hex>" --description "..."`) before applying it.