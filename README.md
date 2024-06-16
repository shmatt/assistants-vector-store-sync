# Assistants Vector Store Sync

A GitHub action to sync files from your repository to an OpenAI Assistants v2 Vector Store

Perfect for turning a static website, Obsidian vault, or a project's source code into a knowledge base for a ChatGPT assistant.

## Features

- Only uploads changes on each run.

- Will remove files from the vector store that are removed from the repository.

- Can differentiate from other Files and Vector Stores within the organization.

- Will filter out both unsuported and empty files.

- Defaults to all markdown files in the repository, but can be set to other files types or paths by using a glob patter.


## Inputs

- `pattern`: The glob pattern matching the files to sync. Default: `**/*.md`.
- `token`: The OpenAI API token. Default: `${{ secrets.OPENAI_API_KEY }}`.
- `key`: A key used to identify the synced files and the vector store. Defaults to the repository name.


## Example usage

```yaml
- uses: actions/checkout@v3

- name: Create index of frontmatter
  uses: shmatt/assistants-vector-store-sync@v1
  with:
    pattern: "**/*.md"
    token: ${{ secrets.OPENAI_API_KEY }}
    key: knowledge-base
```

## How it works

The action uses a key, which is derived from the repository name (without the owner prefix) but may be provided via the `key` input.

It will look for a Vector Store that has metadata with the metadata key `key` set to the provided value / repository name. If one doesn't exist, it will be created with the name also set the value.

For example, if the key or repostory name is `knowledge-base`, the Vector Store as JSON would look like:

```json
{
  ...
  "name": "knowledge-base",
  "metatadata": {
    "key": "knowledge-base"
    ...
  }
}
```

The relative paths of matching files from the repository are prefixed with `{key}-{md5hash}/`, with the `md5hash` being a hash of the file contents.  This key / hash combination is to enable the action to track the files. The name of the uploaded file is then set to the result.

The action will then;

1. upload new or changed files;
2. remove deleted or replaced files; and
3. ensure files are added to the Vector Store.

You can then attach the Vector Store to an Assistant using the `tool_resources` field in your code, or manually in the OpenAI Assistants playground.

## Contributing

Contributions are welcome! Please open an issue or a pull request.

