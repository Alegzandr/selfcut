# Product

## Register

product

## Users

Monteurs vidéo amateurs et créateurs de contenu court (YouTube, TikTok). Deux contextes distincts :

- **Mobile (pointeur grossier)** : montage au pouce, debout ou en déplacement, attentes calquées sur CapCut — barre d'actions contextuelle, gestes tactiles, une action à la fois.
- **Desktop (pointeur fin)** : montage assis, attentes calquées sur Vegas / Premiere — timeline dense, raccourcis clavier (P punch-in, N snap, S split, Ctrl+E export, Ctrl+A), panneaux fixes, inspecteur permanent.

Le job : importer des rushes, découper/arranger sur la timeline, ajuster (volume, vitesse, fades, crop), exporter vers YouTube 16:9, TikTok 9:16 ou MP3. Sessions courtes, montage de forme courte.

## Product Purpose

SelfCut est un éditeur vidéo 100% client-side : aucun upload, les médias ne quittent jamais l'appareil (WebCodecs + mediabunny). Le succès : un monteur qui connaît CapCut ou Vegas retrouve ses réflexes immédiatement et exporte sans friction.

## Brand Personality

Sobre, précis, outil. Trois mots : **efficace, discret, fiable**. L'interface disparaît derrière la tâche de montage ; le contenu vidéo de l'utilisateur est la vedette.

## Anti-references

- **Usine à gaz pro (Premiere)** : pas de dizaines de panneaux et menus visibles en permanence. La densité doit être progressive, pas imposée.
- **Jouet grand public** : pas de gros boutons colorés qui simplifient au point de brider le montage.
- **SaaS générique** : pas de cards, gradients, dashboard-look. C'est un outil de montage, pas un produit SaaS.

## Design Principles

1. **Réflexes empruntés, jamais réinventés** — chaque affordance vient de CapCut (mobile) ou Vegas (desktop) ; l'utilisateur ne doit rien réapprendre.
2. **Le contexte détermine l'UI** — pointeur grossier vs fin sélectionne le mode ; jamais un compromis hybride bancal.
3. **Divulgation progressive** — les actions de clip apparaissent à la sélection ; l'inspecteur détaille sans envahir.
4. **La timeline est reine** — le maximum d'espace et de précision va à la timeline ; le reste s'efface.
5. **Une action, un chemin évident** — split, trim, export : toujours joignables en un geste depuis l'état courant.

## Accessibility & Inclusion

WCAG AA strict : contrastes AA vérifiables (y compris sur les états désactivés et le thème sombre), cibles tactiles ≥ 44px en mode mobile, navigation clavier complète sur desktop, focus visible, `aria-label` sur les boutons icône-seule, prise en charge des lecteurs d'écran y compris sur la timeline (rôles et annonces des clips).
