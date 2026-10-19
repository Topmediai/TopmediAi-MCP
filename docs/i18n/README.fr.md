# TopMediAi-MCP

[English](../../README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Français** · [Español](README.es.md) · [Italiano](README.it.md) · [繁體中文](README.zh-TW.md)

Serveur MCP local TypeScript utilisant stdio et plugin Codex pour TopMediai. La version **1.0.0** prend en charge la génération d’images, l’image vers image, la musique, la vidéo, la vidéo avec références multimédias, la synthèse vocale (TTS) et la conversion de voix (STS). Elle propose catalogues de modèles, estimations de coût, validation du budget, reprise des tâches et aperçus image/audio/vidéo. La réduction du bruit, le clonage vocal et les clips musicaux ne sont pas disponibles.

La génération utilise les droits du compte connecté. Consultez les modèles et obtenez un devis exact avant tout envoi, puis respectez le budget et les préférences de confirmation de la conversation. L’envoi de fichiers nécessite une autorisation de stockage externe ; leurs URL peuvent être accessibles publiquement. Voir [Données et confidentialité (anglais)](../privacy.md).

## Installation et connexion

Prérequis : Node.js >= 22.18, Codex CLI et accès à la page officielle de connexion. L’authentification par navigateur prend actuellement en charge un navigateur et un serveur MCP sur le même ordinateur Windows. Utilisez `npm.cmd` dans PowerShell ; les autres shells compatibles peuvent utiliser `npm`.

Dans le répertoire du projet :

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Le plugin apparaît sous `TopMediAi-MCP`, avec l’identifiant `topmediai-mcp@topmediai-local`. L’installation crée `plugin/.mcp.json` localement sans y stocker de jeton ni de cookie. Ce fichier contient des chemins d’exécutables locaux : ne le versionnez pas et ne le distribuez pas. Réinstallez après avoir déplacé le projet ou changé d’ordinateur.

Appelez `get_service_status` dans la conversation actuelle. Si nécessaire, utilisez `start_login`, vérifiez le compte sur la page officielle et autorisez la connexion. Répétez `wait_for_login` avec le même `login_id` jusqu’à l’enregistrement ou la fin de session. Ensuite, appelez `get_service_status` et `get_balance` dans la même conversation et reprenez la demande initiale. Aucun redémarrage de Codex ou du MCP n’est requis.

Commandes CLI de secours :

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

La connexion attend au maximum dix minutes. Les liens privés sont masqués par défaut. Si le navigateur ne s’ouvre pas, utilisez `--show-private-link` uniquement en local. Ne partagez pas ce lien, ne le capturez pas et ne le collez pas dans la conversation.

Le contrôle d’installation prouve seulement qu’un processus MCP distinct démarre, pas que la conversation a chargé les outils ou que les identifiants sont valides. En cas d’outils absents, vérifiez l’activation du plugin, actualisez le paquet et reconnectez le MCP ; ouvrez une nouvelle conversation si nécessaire. N’attribuez jamais les résultats d’un autre générateur à TopMediai.

## Environnement et configuration

L’installateur public, le serveur et la CLI prennent en charge **uniquement la production**, avec adresses officielles du site et des API intégrées. Aucun fichier `.env`, choix d’environnement, nom d’hôte ou jeton à copier n’est nécessaire pour commencer. Réglages facultatifs : [.env.example](../../.env.example). Voir [Configuration de production (anglais)](../production-switch.md).

- Les API directes sont utilisées par défaut. Les adresses doivent être des origines HTTPS valides ; les valeurs obligatoires explicitement vides sont refusées. L’ancienne passerelle, limitée, nécessite `TOPMEDIAI_PRODUCTION_GATEWAY_HOST` explicite.
- L’installation lit la configuration du shell et fixe les adresses, l’environnement et les réglages d’envoi. Définissez les substitutions avant l’installation. Les commentaires de l’exemple expliquent le démarrage direct et la CLI de connexion.
- Les installations normales utilisent les identifiants privés enregistrés. `TOPMEDIAI_TOKEN` est une substitution explicite qui ne doit figurer dans aucun fichier public, capture ou rapport. L’installation standard efface cette substitution pour éviter d’anciens identifiants.
- Sous Windows, les identifiants sont enregistrés dans `%LOCALAPPDATA%\TopMediai\credentials\` et revérifiés avant chaque appel. Un changement de compte sélectionne son répertoire de tâches ; les requêtes en cours gardent leur compte initial.
- Aucun interrupteur supplémentaire n’est nécessaire pour générer ou envoyer des fichiers. Les envois exigent toujours l’autorisation pour les fichiers précis et un répertoire dédié. Après modification des adresses, réglages ou du code, actualisez configuration et paquet, puis reconnectez le MCP.
- La déconnexion locale supprime les identifiants enregistrés sans déconnecter le site, révoquer les jetons serveur ni annuler les tâches soumises.

```powershell
npm.cmd run setup:plugin
```

Après mise à jour, vérifiez `get_service_status.server_version`. Ne supposez pas qu’un redémarrage complet est nécessaire.

## Outils et création

| Usage | Outils principaux |
| --- | --- |
| État et connexion | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| Compte et planification | `get_balance`, `review_generation_plan` |
| Images | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| Références et aperçu image | `upload_reference_image`, `preview_image_task` |
| Musique | `list_music_models`, `estimate_music_cost`, `generate_music` |
| Vidéo | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| Voix | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| Suivi multimédia et lecture | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

La liste réellement chargée fait foi. Sans modèle demandé, utilisez le modèle par défaut du catalogue actuel, sans changement autonome selon le prix ou le style. Consultez les paramètres, limites, langues et capacités du catalogue. Un modèle répertorié ne garantit pas la disponibilité du devis ou de la génération.

Soumettez avec un devis valide, un `request_id` stable et un budget explicite. `review_generation_plan` regroupe les devis du processus courant. Par défaut, une confirmation est requise pour certains modèles coûteux ou un total estimé **strictement supérieur à 1000 crédits**. Les préférences explicites de l’utilisateur priment. Réévaluez après expiration, modification des entrées ou hausse du prix. L’outil ne remplace pas le consentement et le budget local n’est pas un plafond imposé par le serveur.

Délais dépassés, annulations, déconnexions et résultat d’envoi inconnu ne prouvent pas l’absence de génération ou de facturation. Conservez les identifiants initiaux, consultez l’historique du compte et ne régénérez jamais automatiquement. Vérifiez aussi l’historique si un changement de compte ou de configuration masque une tâche.

Privilégiez l’aperçu des images terminées. Pour un lien expiré, interrogez la tâche initiale avec `get_image_task({request_id, refresh_result:true})` ; son renouvellement n’est pas garanti. Livrez l’audio avec un lecteur ou des liens nommés et la vidéo avec un lecteur intégré et les liens originaux. Distinguez les erreurs d’aperçu des échecs de génération et livrez les résultats réussis même en cas d’échec partiel.

## Aperçu vidéo

Après génération, appelez `preview_video_task` avec le `task_handle` initial et joignez les liens nommés des vidéos originales. Le lecteur en lecture seule permet lecture au clic, pause, recherche, volume, plein écran et nouvel essai. Affichez les versions réussies sans rouvrir les cartes inchangées.

L’aperçu lit les tâches enregistrées du compte sans interrogation du serveur de génération, téléchargement local, génération, dépense ni modification des tâches. Seuls les CDN vidéo autorisés fournissent les médias, sans identifiants du compte. Une interface ou un format incompatible, ou un échec de lecture, conserve les liens originaux et ne justifie jamais une régénération. Navigation, captures et téléchargements exigent une demande explicite.

Actualisez le paquet, reconnectez le MCP et vérifiez `server_version=1.0.0`, 35 outils et `preview_video_task`. L’affichage et le plein écran dépendent de l’hôte.

## Envoi des références

Choisissez uniquement les fichiers autorisés dans un répertoire dédié, sans étendre l’accès aux dossiers personnels ou d’identifiants.

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

Créez d’abord le répertoire et placez-y les fichiers autorisés, puis actualisez la configuration et reconnectez le MCP.

- **Images :** PNG/JPEG, 5 MiB maximum. Utilisez le `reference_image_id` renvoyé, sans le deviner ni le réutiliser entre comptes. [Envoi d’images (anglais)](../image-to-image-security.md).
- **Références vidéo :** MP4/WAV/MP3. Répertoire dédié et FFmpeg/FFprobe locaux requis. Consultez les limites de nombre, taille, durée et combinaison par modèle/opération. Identifiants et ordre sont liés au devis.
- **Audio source STS :** MP3/WAV/AAC/FLAC/AIFF/OGG, au maximum 50 MiB et 300 secondes. Même répertoire dédié et FFmpeg/FFprobe requis. [Guide vocal (anglais)](../speech-integration.md).

La validation locale et la suppression des métadonnées ne rendent pas les fichiers cloud privés. Ne copiez pas directement URL d’envoi, liens de résultats ou rapports complets dans des signalements publics.

## Diagnostic et rapports partagés

```powershell
# Lecture seule, sans soumission de génération
npm.cmd run diagnose
# Créer aussi une copie expurgée pour le partage
npm.cmd run diagnose -- --share-report
```

La console affiche un résumé par défaut. Le rapport complet `.data/diagnostic-runs/latest-production.json` est privé. La copie `.data/diagnostic-runs/shared-production.json` masque identifiants de compte, prompts, montants, URL de médias, liens privés et chemins locaux. Vérifiez-la avant partage ; renommer le rapport complet ne l’expurge pas. Les résultats MCP normaux contiennent toujours les vrais soldes et liens utilisables.

## Développement et vérifications de publication

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` crée un instantané indépendant des fichiers vérifiés et initialise un dépôt Git local sans hériter de l’historique initial. Publiez uniquement une copie ayant passé les contrôles. Modifier les fichiers actuels ne supprime pas l’ancien historique. Voir [Vérifications de publication (anglais)](../releasing.md).

## Licence

Le code original est sous [MIT License](../../LICENSE), copyright TopMediai. Les composants tiers et dépendances conservent leurs propres licences et mentions.

La licence du code ne donne pas accès gratuitement aux services cloud TopMediai. Connexion, génération, envois et autres services restent soumis aux droits du compte, tarifs et conditions applicables. Le nom, les marques et l’icône de marque sont exclus de cette autorisation MIT et nécessitent une autorisation appropriée.
