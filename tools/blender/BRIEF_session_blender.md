# Consigne pour la session Claude reliée à Blender

Colle ce texte dans la session qui a le connecteur Blender, avec l'image de référence de la baleine à bosse et le fichier `whale_pipeline.py`.

---

Tu travailles dans Blender via le connecteur. Objectif : produire **une baleine à bosse low-poly, riggée, au format GLB**, pour une app web three.js (« Baleines »). Dans l'app, la caméra regarde la mer d'en haut (plongée de 60 à 75°), et la baleine fait 75 à 170 px de long à l'écran.

**1. Modéliser la baleine toi-même, d'après l'image de référence jointe.** C'est ta propre création, donc sans problème de licence. N'importe aucun modèle trouvé en ligne.

- Base : une « coque » lissée le long d'un axe (sections elliptiques, rayon qui grandit vers l'avant puis s'amincit jusqu'au pédoncule caudal), plus les nageoires et la queue en volumes aplatis. Longueur totale 1,0.
- **Vue de dessus, c'est elle qui compte dans l'app :**
  - nageoires pectorales très longues, environ **un tiers de la longueur du corps**, attachées vers 30 % depuis la tête et orientées vers l'arrière et vers l'extérieur ;
  - queue large, environ un tiers de la longueur, avec un bord de fuite légèrement dentelé ;
  - petite bosse dorsale vers les deux tiers arrière.
- **Vue de côté :** tête plus plate sur le dessus, mâchoire inférieure arrondie, ventre bombé à l'avant.
- Les tubercules de la tête et les sillons du ventre sont inutiles : invisibles à cette taille.
- Budget : **3 000 triangles au plus** au final. Vise environ 2 500.

**2. Lancer `whale_pipeline.py`** sur ce maillage (sélectionné et actif), avec `species = 'humpback'` et `out = '//humpback.glb'`. Le script :
- normalise la baleine (tête vers +Y, dos vers +Z, longueur 1) ;
- réduit le nombre de triangles ;
- pose 8 os (corps, 4 vertèbres, queue, 2 nageoires) et les poids ;
- crée l'animation `idle` (ondulation verticale de la queue, en boucle) ;
- peint les couleurs par sommet (dos sombre, ventre et nageoires clairs) ;
- exporte le GLB et affiche les contrôles d'acceptation.

Le script n'a encore jamais tourné : corrige-le si une API Blender a changé, sans changer ce qu'il produit.

**3. Vérifier et ajuster.**
- **Tous les contrôles affichés doivent être en PASS :**
  - ≤ 250 Ko et ≤ 3 000 triangles ;
  - 1 squelette de ≤ 16 os ;
  - une seule animation, nommée exactement `idle` ;
  - des couleurs par sommet ;
  - aucune extension requise.
- **Débattement du bout de la queue :** entre 0,05 et 0,08 longueur de corps. Sinon, ajuster `IDLE_AMPLITUDES`.
- **Si `head_axis` a été mal deviné**, le fixer à la main et relancer.
- **Regarder l'animation `idle` dans la vue 3D :** la queue doit onduler de haut en bas (pas de gauche à droite, contrairement à un poisson), et le corps ne doit pas se déformer bizarrement près des nageoires.

**4. Livrer :**
- `humpback.glb` ;
- deux captures de la vue 3D, vue de dessus et vue de côté ;
- la sortie texte complète du script.

Ensuite, même démarche pour la baleine bleue (`species = 'blue'`) : plus longue et fine, tête plate en U vue de dessus, nageoires courtes (environ un huitième de la longueur), très petite nageoire dorsale vers les trois quarts arrière. Puis le cachalot (`species = 'sperm'`) : tête en bloc sur environ un tiers du corps, petites nageoires, bosse dorsale basse.
