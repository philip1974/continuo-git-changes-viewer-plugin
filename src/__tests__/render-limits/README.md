# Render Limits

A repository (hostile or just huge) can produce a diff with hundreds of
thousands of lines or a status with tens of thousands of entries. The panel
renders one element per diff line / per file row without virtualization, so
both are capped; nothing is dropped from the underlying data.

- L1: a unified diff longer than `MAX_DIFF_LINES` (5000) renders only the
  first 5000 lines followed by a notice with the total line count.
- L2: a diff at or below the limit renders completely, without the notice.
- L3: hunk actions on the rendered part still build their patch from the full
  diff (a hunk crossing the cut is extracted whole).
- L4: a file-list section with more than `MAX_SECTION_ROWS` (2000) entries
  renders the first 2000 rows and a notice; the section count still shows the
  real total.
- L5: sections at or below the limit render completely, without the notice.
- L7: a new / untracked file larger than the whole-file read limit
  (`MAX_FILE_BYTES`, 1 MiB) shows the part that was read followed by "File too
  large — showing the first 1 MB. Open the file in an editor to see the rest."
- L8: a file within the limit shows no notice.
- L10: a read that timed out (`modifiedTimedOut`) shows the part that was read
  followed by "Reading this file took too long — showing only the part that
  was read. Open the file in an editor to see the rest."
- L9: a staged new entry without a staged blob (`withheld:
  'no-staged-blob'`: submodule entry, unresolved conflict) shows "No staged
  file content to show (…)" instead of "(empty file)".
- L6: a status output truncated by the host output limit loses only its last,
  possibly partial record — it is never parsed into a bogus entry. The scan
  reports the list as incomplete (`StatusUnavailableError.partial` carries the
  complete records; see `status-unavailable`).
