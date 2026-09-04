# Sample import files

Drop any of these on **Import** (or copy the CSV rows into **Configuration → Paste list**) to
try the import builder. They all describe the same handful of sites in different shapes:

| File              | Shape                                     | What it exercises                                                                                   |
| ----------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `sites.csv`       | Flat spreadsheet export                   | Auto-detected `Site Name` / `IP Address` / `Region` / `Template` columns and a `Web Port` variable  |
| `sites.json`      | Wrapped list with nested objects          | Record list discovery (`sites`) and dotted columns (`network.ip`)                                   |
| `sites.yaml`      | Same list in YAML                         | A YAML file that is not an OPOSSUM configuration                                                    |
| `sites.xml`       | Repeated elements with attributes         | Attribute and child-element columns                                                                 |
| `rdm-export.json` | Devolutions Remote Desktop Manager export | Folder → group resolution, host lifted from `Terminal.Host` / `Host` / `Url`, connection type names |

The `ebo-site` template referenced by these files ships in `opossum.example.yaml`; load the
example configuration first, or pick another template in the builder's **Defaults** step.
Addresses use documentation ranges (10.20.x.x, 192.0.2.x) and will simply fail to respond.
