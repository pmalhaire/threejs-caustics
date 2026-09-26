# Consigne pour la session Claude reliée à Blender — 4ᵉ variante "classic"

Colle ce texte dans la session qui a le connecteur Blender, avec le fichier
`assets/whale.obj` du dépôt (le modèle d'origine, importe-le toi-même dans
Blender) et le fichier `whale_pipeline.py` déjà à jour (contient maintenant
l'entrée `'classic'` dans `SPECIES`).

---

Tu travailles dans Blender via le connecteur. Objectif : rigger le modèle de
baleine d'origine de l'app (`assets/whale.obj`, un maillage 3ds Max de 2011
sans licence documentée) pour qu'il devienne une 4ᵉ variante utilisable dans
l'app three.js « Baleines », au même format que les 3 autres déjà produites
(`humpback.glb`, `blue.glb`, `sperm.glb`).

**1. Importer `assets/whale.obj` dans Blender.** Ne pas le modifier
manuellement (le sujet ici n'est pas la modélisation, juste le rig) : le but
est de rigger le maillage existant tel quel, aussi encombré soit-il, avec un
budget triangles ramené à 3000 par `whale_pipeline.py`.

**2. Lancer `whale_pipeline.py`** sur ce maillage (sélectionné et actif), avec
`species = 'classic'` et `out = '//classic.glb'`. Le script :
- normalise la baleine (tête vers +Y, dos vers +Z, longueur 1) ;
- réduit le nombre de triangles à ≤ 3000 ;
- pose 8 os (corps, 4 vertèbres, queue, 2 nageoires) et les poids ;
- crée l'animation `idle` (ondulation verticale de la queue, en boucle) ;
- peint les couleurs par sommet ;
- exporte le GLB et affiche les contrôles d'acceptation.

Le script a déjà tourné avec succès sur 3 maillages différents (mêmes API
Blender) : il ne devrait pas y avoir besoin de le corriger, mais vérifie
quand même les messages affichés.

**3. Vérifier et ajuster**, mêmes critères que les 3 autres espèces :
- **Tous les contrôles affichés doivent être en PASS :**
  - ≤ 250 Ko et ≤ 3 000 triangles ;
  - 1 squelette de ≤ 16 os ;
  - une seule animation, nommée exactement `idle` ;
  - des couleurs par sommet ;
  - aucune extension requise.
- **Débattement du bout de la queue :** entre 0,05 et 0,08 longueur de corps.
  Sinon, ajuster `IDLE_AMPLITUDES`.
- **Si `head_axis` a été mal deviné**, le fixer à la main et relancer (le
  maillage d'origine, tourné de 90° autour de Z dans l'app actuelle, n'a pas
  forcément le même axe de tête que les 3 espèces déjà traitées).
- **Regarder l'animation `idle` dans la vue 3D :** la queue doit onduler de
  haut en bas, le corps ne doit pas se déformer bizarrement près des
  nageoires.

**4. Livrer :**
- `classic.glb` ;
- deux captures de la vue 3D, vue de dessus et vue de côté ;
- la sortie texte complète du script.
