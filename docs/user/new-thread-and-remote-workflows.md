# New Threads, Remote Projects, and Terminals

The **New** button is the quickest way to choose where the next task should run. Only connected
machines are offered.

## Start without a project

Choose **No project**, then choose a machine. T3 Code opens a clean scratch workspace on that
machine so you can start prompting immediately without selecting a repository or project folder.

## Open a terminal on any machine

Choose **Open terminal on...**, then choose a connected machine. T3 Code opens that machine's
scratch workspace and expands its embedded terminal. Commands execute on the selected machine,
including machines connected through T3 Connect.

Terminals opened inside an existing project continue to execute on the machine shown for that
project.

## Browse or create a project folder

Choose **Choose or create project folder**, then choose a connected machine. The directory browser
lists folders from that machine's filesystem—not from the computer displaying the app.

- Select an existing folder to add it as a project and start a new thread.
- Type a path that does not exist yet and choose **Create & Add** to create the folder on that
  machine, add it as a project, and start a new thread there.
- Use `~/` to begin in the selected machine's home directory.

The desktop-native Explorer/Finder picker is available only for filesystems hosted by the desktop
itself. Remote machines always use T3 Code's built-in directory browser.
