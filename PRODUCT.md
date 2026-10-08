# Product

## Register

product

## Identity

SelfCut, c'est faire sa part du montage soi-même, bien, puis livrer. Le nom porte les trois sens du produit :

- **Fait soi-même** : pour ceux qui ne sont pas monteurs et ne veulent pas le devenir.
- **Chez soi** : rien ne part sur un serveur, pas de compte, pas d'installation.
- **Soi à l'écran** : face caméra, voix, sous-titres, le contenu typique des réseaux.

SelfCut n'est ni un clone d'Adobe (la puissance moins chère) ni un clone de CapCut (les templates et les tendances). Il promet une vidéo livrée propre, que la destination soit une plateforme ou un monteur.

## Users

Créateurs de contenu court (YouTube, TikTok, Reels) et toute personne qui doit monter sans être monteur. Trois usages :

- **Publier soi-même** : importer des rushes, couper, ajuster, exporter en 16:9, 9:16 ou MP3 vers la plateforme. Sessions courtes, montage de forme courte.
- **Préparer pour un monteur** : dérusher, couper des clips, couper un micro, équilibrer les pistes, puis passer la main à un monteur qui travaille sur Premiere ou DaVinci. C'est un usage à part entière, pas un échec de rétention.
- **Retoucher vite** : une coupe, un volume, un flou sur un visage, et c'est reparti.

Deux contextes d'utilisation :

- **Mobile (pointeur grossier)** : montage au pouce, debout ou en déplacement. Les réflexes viennent de CapCut : barre d'actions contextuelle, gestes tactiles, une action à la fois. Les utilisateurs adorent cette approche sur mobile et la rejettent sur desktop : elle n'en sort pas.
- **Desktop (pointeur fin)** : montage assis. La base est Vegas, l'interface que les utilisateurs comprennent le mieux : timeline dense, raccourcis clavier (P zoom instantané, N magnétisme, S diviser, Ctrl+E export, Ctrl+A), panneaux fixes, inspecteur permanent. Les bizarreries de Vegas sont corrigées en reprenant l'approche Adobe, leur deuxième référence. Vegas d'abord, Adobe pour corriger, jamais l'inverse.

Ce qui fait fuir la concurrence, débutants comme monteurs expérimentés, c'est une interface où l'on galère à trouver comment faire ce qu'on a à faire : Premiere demande trop de tutoriels pour qu'on l'installe encore, DaVinci n'a pas su se simplifier, OpenCut a été rejeté. La découvrabilité est le premier critère de chaque décision d'interface.

## Product Purpose

SelfCut est un éditeur vidéo 100% client-side : les médias ne quittent jamais l'appareil (WebCodecs + mediabunny). Le succès : quelqu'un qui vient de CapCut, Vegas ou Premiere retrouve ses réflexes immédiatement, ne bute pas sur ce qui le gênait là-bas, et livre une vidéo propre sans avoir eu besoin du savoir d'un monteur.

## Brand Personality

Sobre, précis, outil. Trois mots : **efficace, discret, fiable**. L'interface disparaît derrière la tâche ; le contenu de l'utilisateur est la vedette.

## Anti-references

- **Usine à gaz pro (Premiere)** : pas de dizaines de panneaux et menus visibles en permanence. La densité est progressive, jamais imposée.
- **Chimère** : SelfCut ne juxtapose pas des morceaux de Vegas, d'Adobe et de CapCut. Il emprunte des réflexes, pas des interfaces entières, et range le tout selon sa propre logique.
- **Jouet grand public** : pas de gros boutons colorés qui simplifient au point de brider le montage.
- **SaaS générique** : pas de cards, gradients, dashboard-look. C'est un outil de montage, pas un produit SaaS.
- **Enfermement** : pas de filigrane, pas de mur payant au moment de l'export, pas de format captif. L'utilisateur part avec ses fichiers quand il veut.

## Design Principles

1. **Réflexes empruntés, frictions retirées** : on reprend les gestes que l'utilisateur a déjà appris ailleurs, là où il va le plus probablement se retrouver, et on retravaille ce qui le gênait chez la concurrence. On tranche pour lui : un seul jeu de raccourcis, un seul comportement, pas de profils au choix.
2. **L'intention avant l'outil** : les actions sont nommées et rangées par résultat (rendre la voix claire, mettre les voix au même niveau, flouter un visage) plutôt que par technique (leveler, normalize, redaction). Le réglage fin reste accessible sous l'intention, jamais à sa place.
3. **Bon par défaut** : SelfCut porte le savoir-faire à la place de l'utilisateur. Un export sans réglage doit déjà être juste pour sa destination (niveau sonore des plateformes, limiteur, formats). L'option sert à s'écarter du bon défaut, pas à l'atteindre.
4. **Livrer propre, où que ça aille** : la réussite se mesure au temps entre l'import et la livraison, que la livraison soit une publication ou un passage de main à un monteur. Les deux sorties sont des citoyens de première classe.
5. **Chez soi** : le local est une contrainte de conception, pas un argument marketing. Fonctionnement hors ligne, aucun média envoyé, fichiers de projet portables, l'utilisateur garde la main sur ce qu'il partage et à qui.
6. **Le contexte détermine l'UI** : pointeur grossier ou fin sélectionne le mode ; jamais un compromis hybride bancal.
7. **Divulgation progressive** : les actions de clip apparaissent à la sélection ; l'inspecteur détaille sans envahir. La profondeur (courbes, scopes, images clés, masques) existe, rangée derrière l'intention.
8. **La timeline est reine** : le maximum d'espace et de précision va à la timeline ; le reste s'efface.
9. **Une action, un chemin évident** : split, trim, export : toujours joignables en un geste depuis l'état courant.

## Accessibility & Inclusion

WCAG AA strict : contrastes AA vérifiables (y compris sur les états désactivés et le thème sombre), cibles tactiles ≥ 44px en mode mobile, navigation clavier complète sur desktop, focus visible, `aria-label` sur les boutons icône-seule, prise en charge des lecteurs d'écran y compris sur la timeline (rôles et annonces des clips).
