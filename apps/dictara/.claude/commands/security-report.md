---
description: Security report
---

# Steps:

## Step 1: Run a security scan

Run the exact promt in a sub agent to get a security review for the whole project:

```
/security-review run security review for the whole repo
```

## Step 2: Review the results

Review the results and alert a user if there are any security issues.

## Step 3: Update the report

Update the report with the results of the security scan.

The report is located in: `security/report.md`

The report should contain the following:

```
# Summary

<Project summary, single paragraph what is the project about>

# Security Risks/Issues

<List of security risks/issues observed>
<If no issues, write "No issues observed">
<Do not mention false positives>

# Positive Security Practices Observed

<List of positive security practices observed>

```
