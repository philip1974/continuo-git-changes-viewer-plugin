

The diff cache never outlives the status it was read under:

- T7: a successful refresh drops every cached diff (not only the selected
  one) and loads the selected one again — a staged file that was edited and
  staged again keeps the status `M `, and its cached diff would show the old
  version while a commit takes the new one.
- T8: selecting a row always fetches its diff again.
