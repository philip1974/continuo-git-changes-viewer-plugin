# Git store refresh reconciliation

BDD coverage for preserving or replacing selected path+mode across refreshes.


- T19: a refresh keeps the selection and drops every cached diff except the
  one on screen, which stays — marked as being refreshed — until its
  replacement arrives (`git-store` T17–T21).
