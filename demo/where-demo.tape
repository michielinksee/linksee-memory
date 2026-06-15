# vhs tape for the `where`-first demo. Generate a GIF with:
#   npm i -g @charmbracelet/vhs   (or: brew install vhs)
#   linksee-memory-map ... must be on PATH (pnpm link --global in the repo)
#   cd demo && vhs where-demo.tape   →  where-demo.gif
#
# The story: edit a file → where am I? → wait, reality says drift → here's the evidence.

Output where-demo.gif

Set FontSize 19
Set Width 1200
Set Height 780
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 55ms

Hide
Type "clear"
Enter
Show

# 1. Where am I, and what does this file touch?
Type "linksee-memory-map where README.md"
Sleep 500ms
Enter
Sleep 3s

# 2. Why is it in this state? — reality says it drifted, with evidence.
Type "linksee-memory-map explain readme"
Sleep 500ms
Enter
Sleep 4500ms

# 3. Whole-project triage.
Type "linksee-memory-map status"
Sleep 500ms
Enter
Sleep 3s

Sleep 1500ms
