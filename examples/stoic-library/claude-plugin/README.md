# The Stoic Library

Search the Stoic classics by topic or look up a passage by reference. Retrieve exact excerpts, named translations, whole letters and chapters, and surrounding context. Follow edition-specific links to read more in The Stoic Library. Search results are candidates for your assistant to evaluate; the tools do not generate philosophical advice or authenticate quotations absent from the indexed corpus.

This plugin bundles one remote MCP connector and one skill. The connector points to `https://thestoiclibrary.com/mcp`, a public, read-only, no-authentication endpoint operated by Gerald Norby. It exposes two tools: one searches the library's public-domain Stoic translations for candidate passages, and one retrieves exact text, edition metadata, surrounding sections and reading links. The skill describes when to use the tools and how to interpret their results.

## What the plugin sends and receives

When Claude calls a tool, it sends the endpoint short search terms or a passage reference, optional author, work and edition filters, and pagination or context settings. The endpoint returns public source text and metadata. It makes no calls to an AI provider, requires no account, and does not write tool inputs or results to an application log or database. Leave personal details out of queries. The plugin contains no executable code, hooks or local servers.

Privacy policy: https://thestoiclibrary.com/plugin/privacy
Terms: https://thestoiclibrary.com/plugin/terms
Support: https://norbonics.com/support (support@norbonics.com)

## Install

In Claude Code:

```
claude plugin marketplace add DlaregY/the-stoic-library-claude-plugin
claude plugin install the-stoic-library@norbonics
```

In Claude chat or Cowork, upload the release ZIP under Customize > Plugins > Upload plugin.

## Try it

- Find Stoic passages about anger after criticism.
- Show me Enchiridion 20 in Elizabeth Carter's translation.
- Read Seneca Letter 1 and show its source.

Search results are candidates, not verified answers. An empty search does not prove a quotation inauthentic.
