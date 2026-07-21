# CUES Raw Editorial Brief Example

Use this text as the raw brief when you want the LLM to name clusters naturally.

```text
You are analyzing LinkedIn editorial content for CUES.

Goal:
Group posts into editorial topics that reflect the organization’s communication priorities. The clusters should emerge naturally from the content and the strategy, not from hardcoded labels.

Editorial direction:
CUES wants to highlight innovation in packaging and products, heritage and brand storytelling, sustainability and circular economy, traceability and food safety, and the European institutional context around food and agriculture.

What to look for:
- innovation, packaging, product development, modernization
- heritage, tradition, legacy, communication tone, brand identity
- sustainability, circularity, waste reduction, environmental responsibility
- traceability, safety, quality assurance, compliance, supply chain transparency
- European policy, institutions, regulatory context, sector-level framing

Instructions:
- Read the cluster evidence and infer the best natural editorial title.
- Keep titles short, clear, and human.
- Do not force identical wording across clusters.
- Make the title reflect the dominant editorial meaning of the posts.
- If a cluster is mixed, choose the strongest shared narrative.
- Avoid generic titles like “Cluster A” or “Topic 1”.
```

Shorter version for prompts:

```text
CUES is building an editorial narrative around how food companies communicate change, value, and responsibility.

We want clusters that feel like real editorial themes. The naming should sound like something an editor would write after reading the posts, not like a technical label.

The main directions are:
- innovation and packaging
- heritage and contemporary storytelling
- sustainability and circular economy
- traceability and food safety
- European institutional and policy context

Use the posts themselves to decide the final title. The brief is only there to guide the tone and direction.
```

Suggested use:
- Put the raw brief into the cluster-naming prompt.
- Pass the top representative posts for each cluster.
- Let the model choose the final title from the evidence.