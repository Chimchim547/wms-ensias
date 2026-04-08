const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const { statut, recherche, dateDebut, dateFin } = req.query;
  
  const where = {};
  
  if (statut) {
    where.statut = statut;
  }
  
  if (recherche) {
    where.OR = [
      { numero: { contains: recherche, mode: 'insensitive' } },
      { nomClient: { contains: recherche, mode: 'insensitive' } }
    ];
  }
  
  if (dateDebut || dateFin) {
    where.date = {};
    if (dateDebut) where.date.gte = new Date(dateDebut);
    if (dateFin) {
      const fin = new Date(dateFin);
      fin.setHours(23, 59, 59);
      where.date.lte = fin;
    }
  }
  
  const commandes = await prisma.commande.findMany({
    where,
    include: { lignes: { include: { article: { include: { mouvements: true } } } }, listePicking: true, backorders: true },
    orderBy: { date: 'desc' }
  });

  // Pour les backorders, vérifier si le stock est dispo
  for (const cmd of commandes) {
    if (cmd.statut === 'BACKORDER') {
      cmd.stockDispo = true;
      for (const ligne of cmd.lignes) {
        const entrees = ligne.article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
        const sorties = ligne.article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
        const stockActuel = entrees - sorties;
        if (stockActuel < ligne.quantite) {
          cmd.stockDispo = false;
          break;
        }
      }
    }
  }
  
  const magasiniers = await prisma.utilisateur.findMany({
    where: { role: 'MAGASINIER' }
  });
  res.render('commandes/index', { 
    commandes, magasiniers,
    filtres: { statut: statut || '', recherche: recherche || '', dateDebut: dateDebut || '', dateFin: dateFin || '' }
  });
});

router.get('/preparation', async (req, res) => {
  const commandes = await prisma.commande.findMany({
    where: { statut: { in: ['PICKING', 'PREPARE'] } },
    include: { lignes: { include: { article: true } }, listePicking: true }
  });
  res.render('commandes/preparation', { commandes });
});

router.get('/create', async (req, res) => {
  const articles = await prisma.article.findMany();
  res.render('commandes/create', { articles });
});

router.post('/create', async (req, res) => {
  try {
    const { numero, nomClient, emailClient, adresseClient, articleIds, quantites } = req.body;
    const lignes = [];
    const ids = Array.isArray(articleIds) ? articleIds : [articleIds];
    const qtes = Array.isArray(quantites) ? quantites : [quantites];
    let prixTotal = 0;
    
    for (let i = 0; i < ids.length; i++) {
      const article = await prisma.article.findUnique({ where: { id: parseInt(ids[i]) } });
      prixTotal += article.prix * parseInt(qtes[i]);
      lignes.push({
        articleId: parseInt(ids[i]),
        quantite: parseInt(qtes[i])
      });
    }
    
    await prisma.commande.create({
      data: {
        numero, nomClient, emailClient, adresseClient, prixTotal,
        statut: 'EN_ATTENTE',
        lignes: { create: lignes }
      }
    });

   // Pas de notif pour soi-même, la notif au magasinier viendra au moment du picking

    res.redirect('/commandes');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.post('/picking/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const modePicking = req.body.modePicking || 'SERIE';
  
  const existant = await prisma.listePicking.findUnique({
    where: { commandeId: commandeId }
  });
  
  if (existant) {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } }
  });
  
  const lignesPicking = commande.lignes.map(l => ({
    articleId: l.articleId,
    quantite: l.quantite
  }));
  
  await prisma.listePicking.create({
    data: {
      commandeId,
      modePicking,
      lignes: { create: lignesPicking }
    }
  });
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'PICKING' }
  });

  // Compter les zones pour le mode parallèle
  const zones = new Set();
  commande.lignes.forEach(l => {
    if (l.article.emplacement && l.article.emplacement.zone) {
      zones.add(l.article.emplacement.zone.code);
    }
  });

  const modeText = modePicking === 'PARALLELE' 
    ? `en mode PARALLÈLE (${zones.size} zone(s)). Répartissez-vous les zones.`
    : 'en mode SÉRIE.';

  const magasinierSerieId = req.body.magasinierSerie ? parseInt(req.body.magasinierSerie) : null;

  if (modePicking === 'SERIE' && magasinierSerieId) {
    // Affecter directement le magasinier
    const listePicking = await prisma.listePicking.findUnique({
      where: { commandeId },
      include: { lignes: true }
    });
    
    for (const ligne of listePicking.lignes) {
      await prisma.lignePicking.update({
        where: { id: ligne.id },
        data: { magasinierId: magasinierSerieId }
      });
    }

    const magasinier = await prisma.utilisateur.findUnique({ where: { id: magasinierSerieId } });
    await prisma.notification.create({
      data: {
        message: `📋 Picking série - Commande ${commande.numero} : vous êtes affecté à la préparation de ${commande.lignes.length} article(s). Veuillez prélever.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'MAGASINIER'
      }
    });
  } else if (modePicking === 'PARALLELE') {
    // Mode parallèle : rediriger vers la page picking pour affecter par zone
    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : picking parallèle généré. Veuillez affecter les magasiniers par zone.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'RESPONSABLE_COMMANDE'
      }
    });
    return res.redirect('/commandes/picking/' + commandeId);
  } else {
    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : liste de picking générée ${modeText} Veuillez affecter un magasinier.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'RESPONSABLE_COMMANDE'
      }
    });
  }

  res.redirect('/commandes');
});

router.get('/picking/:id', async (req, res) => {
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } },
      listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } }, magasinier: true } } } }
    }
  });
  const magasiniers = await prisma.utilisateur.findMany({
    where: { role: 'MAGASINIER' }
  });
  res.render('commandes/picking', { commande, magasiniers });
});

router.post('/preparer/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { ligneIds, quantitesPrelevees } = req.body;
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { 
      listePicking: { include: { lignes: true } },
      lignes: true 
    }
  });
  
  if (commande.statut === 'PREPARE' || commande.statut === 'AU_QUAI' || commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  const ids = Array.isArray(ligneIds) ? ligneIds : [ligneIds];
  const qps = Array.isArray(quantitesPrelevees) ? quantitesPrelevees : [quantitesPrelevees];
  
  let toutComplet = true;
  let articlesManquants = [];
  
  for (let i = 0; i < ids.length; i++) {
    const qp = parseInt(qps[i]) || 0;
    const ligne = commande.listePicking.lignes.find(l => l.id === parseInt(ids[i]));
    
    if (qp < ligne.quantite) {
      toutComplet = false;
      articlesManquants.push(`${ligne.quantite - qp} manquant(s)`);
    }
    
    await prisma.lignePicking.update({
      where: { id: parseInt(ids[i]) },
      data: { quantitePrelevee: qp }
    });
  }
  
  for (let i = 0; i < commande.lignes.length; i++) {
    const lignePicking = commande.listePicking.lignes.find(l => l.articleId === commande.lignes[i].articleId);
    const idx = ids.indexOf(String(lignePicking.id));
    const qp = parseInt(qps[idx]) || 0;
    
    await prisma.ligneCommande.update({
      where: { id: commande.lignes[i].id },
      data: { quantitePreparee: qp }
    });
  }
  
  if (toutComplet) {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PREPARE' }
    });

    // Notif responsable commande : préparation complète
    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : tous les articles ont été prélevés avec succès. Prête pour le quai d'expédition.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'RESPONSABLE_COMMANDE'
      }
    });
  } else {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PARTIELLE' }
    });

    // Notif responsable commande : commande partielle
    await prisma.notification.create({
      data: {
        message: `⚠ Commande ${commande.numero} : préparation partielle ! Certains articles n'ont pas été trouvés. Votre décision est requise.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'RESPONSABLE_COMMANDE'
      }
    });
  }

  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/decision/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { decision } = req.body;
  const commande = await prisma.commande.findUnique({ where: { id: commandeId } });
  
 if (decision === 'expedier_partiel') {
    // Récupérer les lignes avec les quantités préparées
    const commandeComplete = await prisma.commande.findUnique({
      where: { id: commandeId },
      include: { 
        lignes: { include: { article: true } },
        listePicking: { include: { lignes: true } }
      }
    });

    // Créer le backorder avec les articles manquants
    const lignesBackorder = [];
    let prixBackorder = 0;

    for (const ligne of commandeComplete.lignes) {
      const lignePicking = commandeComplete.listePicking.lignes.find(l => l.articleId === ligne.articleId);
      const qtePrelevee = lignePicking ? lignePicking.quantitePrelevee : 0;
      const qteManquante = ligne.quantite - qtePrelevee;

      if (qteManquante > 0) {
        prixBackorder += qteManquante * ligne.article.prix;
        lignesBackorder.push({
          articleId: ligne.articleId,
          quantite: qteManquante
        });
      }
    }

    if (lignesBackorder.length > 0) {
      const backorder = await prisma.commande.create({
        data: {
          numero: commande.numero + '-B',
          nomClient: commande.nomClient,
          emailClient: commande.emailClient,
          adresseClient: commande.adresseClient,
          prixTotal: prixBackorder,
          statut: 'BACKORDER',
          commandeParentId: commandeId,
          lignes: { create: lignesBackorder }
        }
      });

      // Notif pour le responsable entrepôt : backorder créé
      await prisma.notification.create({
        data: {
          message: `📦 Backorder ${backorder.numero} créé automatiquement (${lignesBackorder.length} article(s) manquant(s), ${prixBackorder.toFixed(2)} DH). En attente de réapprovisionnement.`,
          lien: '/commandes',
          destinataireRole: 'RESPONSABLE_ENTREPOT'
        }
      });
    }

    // Mettre à jour le prix de la commande originale (uniquement les articles expédiés)
    let prixPartiel = 0;
    for (const ligne of commandeComplete.lignes) {
      const lignePicking = commandeComplete.listePicking.lignes.find(l => l.articleId === ligne.articleId);
      const qtePrelevee = lignePicking ? lignePicking.quantitePrelevee : 0;
      prixPartiel += qtePrelevee * ligne.article.prix;
    }

    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PREPARE', prixTotal: prixPartiel }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : expédition partielle acceptée. Veuillez déplacer les articles vers le quai. Un backorder a été créé pour les articles manquants.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'MAGASINIER'
      }
    });
    // Alerte réapprovisionnement au responsable réception
    if (lignesBackorder.length > 0) {
      const articlesManquants = [];
      for (const lb of lignesBackorder) {
        const art = await prisma.article.findUnique({ where: { id: lb.articleId } });
        articlesManquants.push(art.reference + ' - ' + art.designation + ' (qte: ' + lb.quantite + ')');
      }
      await prisma.notification.create({
        data: {
          message: '🚨 RÉAPPROVISIONNEMENT URGENT : ' + articlesManquants.join(', ') + '. Veuillez contacter le fournisseur.',
          lien: '/reception/create',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
    }
  } else if (decision === 'attendre') {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'EN_ATTENTE_STOCK' }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : le client préfère attendre. Commande mise en attente de réapprovisionnement.`,
        lien: '/commandes',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else if (decision === 'annuler') {
    // Récupérer les articles prélevés pour les remettre en place
    const commandeComplete = await prisma.commande.findUnique({
      where: { id: commandeId },
      include: { 
        lignes: { include: { article: true } },
        listePicking: { include: { lignes: { include: { article: true } } } }
      }
    });

    // Remettre les articles dans leurs emplacements si déplacés
    const articlesARemettre = [];
    for (const ligne of commandeComplete.listePicking.lignes) {
      if (ligne.quantitePrelevee > 0) {
        articlesARemettre.push(ligne.article.reference + ' - ' + ligne.article.designation + ' (qte: ' + ligne.quantitePrelevee + ')');
      }
    }

    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'ANNULEE' }
    });

    if (articlesARemettre.length > 0) {
      await prisma.notification.create({
        data: {
          message: `❌ Commande ${commande.numero} ANNULÉE. Articles à remettre en stock : ${articlesARemettre.join(', ')}. Veuillez les replacer dans leurs emplacements.`,
          lien: '/commandes/picking/' + commandeId,
          destinataireRole: 'MAGASINIER'
        }
      });
    }

    await prisma.notification.create({
      data: {
        message: `❌ Commande ${commande.numero} annulée par le client. ${articlesARemettre.length > 0 ? 'Le magasinier va remettre les articles en stock.' : 'Aucun article n\'avait été prélevé.'}`,
        lien: '/commandes',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }
  
  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/deplacer-quai/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: true } } }
  });
  
  if (commande.statut === 'AU_QUAI' || commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  for (const ligne of commande.lignes) {
    if (ligne.article.emplacementId) {
      await prisma.article.update({
        where: { id: ligne.articleId },
        data: { emplacementId: null }
      });
      
      await prisma.mouvementStock.create({
        data: {
          type: 'TRANSFERT',
          quantite: ligne.quantitePreparee || ligne.quantite,
          articleId: ligne.articleId
        }
      });
    }
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'AU_QUAI' }
  });

  // Notif responsable commande : articles au quai
  await prisma.notification.create({
    data: {
      message: `Commande ${commande.numero} : les articles sont au quai d'expédition. Vous pouvez valider l'expédition.`,
      lien: '/commandes/picking/' + commandeId,
      destinataireRole: 'RESPONSABLE_COMMANDE'
    }
  });

  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/expedier/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: true }
  });
  
  if (commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes');
  }
  
  for (const ligne of commande.lignes) {
    const qte = ligne.quantitePreparee || ligne.quantite;
    await prisma.mouvementStock.create({
      data: {
        type: 'SORTIE',
        quantite: qte,
        articleId: ligne.articleId
      }
    });

    
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'EXPEDIEE', dateExpedition: new Date() }
  });
// Vérifier les alertes de stock bas
  for (const ligne of commande.lignes) {
    const article = await prisma.article.findUnique({ 
      where: { id: ligne.articleId },
      include: { mouvements: true }
    });
    const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    const stockActuel = entrees - sorties;
    
    if (stockActuel <= article.seuilAlerte) {
      await prisma.notification.create({
        data: {
          message: '🔴 ALERTE STOCK BAS : ' + article.reference + ' - ' + article.designation + ' (Stock: ' + stockActuel + ', Seuil: ' + article.seuilAlerte + '). Reapprovisionnement necessaire !',
          lien: '/articles/stock',
          destinataireRole: 'RESPONSABLE_ENTREPOT'
        }
      });
    }
  }
  // Notif responsable entrepôt : stock mis à jour
  await prisma.notification.create({
    data: {
      message: `Commande ${commande.numero} expédiée. Le stock a été mis à jour automatiquement.`,
      lien: '/articles/stock',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect('/commandes');
});
router.get('/pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });

  if (!commande) return res.status(404).send('Commande introuvable');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=BL-' + commande.numero + '.pdf');
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Bon de Livraison', { align: 'center' });
  doc.moveDown();

  // Ligne séparatrice
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Infos commande (gauche) et client (droite)
  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Commande:', 50, infoY);
  doc.font('Helvetica');
  doc.text('Numero: ' + commande.numero, 50, infoY + 15);
  doc.text('Date commande: ' + commande.date.toLocaleDateString('fr-FR'), 50, infoY + 30);
  if (commande.dateExpedition) {
    doc.text('Date expedition: ' + commande.dateExpedition.toLocaleDateString('fr-FR'), 50, infoY + 45);
  }
  doc.text('Statut: ' + commande.statut, 50, infoY + 60);

  doc.font('Helvetica-Bold').text('Client:', 350, infoY);
  doc.font('Helvetica');
  doc.text(commande.nomClient, 350, infoY + 15);
  doc.text(commande.emailClient, 350, infoY + 30);
  doc.text(commande.adresseClient, 350, infoY + 45);

  doc.y = infoY + 90;
  doc.moveDown();

  // Tableau des articles
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Reference', 50, tableTop, { width: 90 });
  doc.text('Designation', 140, tableTop, { width: 170 });
  doc.text('Qte', 310, tableTop, { width: 50 });
  doc.text('Prix unit.', 360, tableTop, { width: 80 });
  doc.text('Total', 440, tableTop, { width: 80 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(10);
  let y = tableTop + 25;
  let totalGeneral = 0;
  
  commande.lignes.forEach(ligne => {
    const qte = ligne.quantitePreparee || ligne.quantite;
    const total = qte * ligne.article.prix;
    totalGeneral += total;
    
    doc.text(ligne.article.reference, 50, y, { width: 90 });
    doc.text(ligne.article.designation, 140, y, { width: 170 });
    doc.text(String(qte), 310, y, { width: 50 });
    doc.text(ligne.article.prix.toFixed(2) + ' DH', 360, y, { width: 80 });
    doc.text(total.toFixed(2) + ' DH', 440, y, { width: 80 });
    y += 20;
  });

  // Total
  doc.moveTo(50, y + 5).lineTo(550, y + 5).stroke();
  y += 15;
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text('Total:', 360, y);
  doc.text(totalGeneral.toFixed(2) + ' DH', 440, y);

  // Signatures
  doc.moveDown(5);
  const sigY = doc.y + 20;
  doc.fontSize(10).font('Helvetica');
  doc.text('Signature expediteur:', 50, sigY);
  doc.text('Signature client:', 350, sigY);
  doc.moveTo(50, sigY + 40).lineTo(200, sigY + 40).stroke();
  doc.moveTo(350, sigY + 40).lineTo(500, sigY + 40).stroke();

  // Pied de page
  doc.moveDown(5);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

router.get('/picking-pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } },
      listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } }, magasinier: true } } } }
    }
  });

  if (!commande || !commande.listePicking) return res.status(404).send('Picking introuvable');

  const isParallele = commande.listePicking.modePicking === 'PARALLELE';
  const isMAG = req.user.role === 'MAGASINIER';

  // Filtrer les lignes selon le rôle
  let lignes = commande.listePicking.lignes;
  if (isMAG && isParallele) {
    lignes = lignes.filter(l => l.magasinierId === req.user.id);
  }

  if (lignes.length === 0) return res.status(404).send('Aucun article affecté');

  const doc = new PDFDocument({ margin: 50 });
  
  const fileName = isMAG ? 'PICKING-' + commande.numero + '-' + req.user.prenom + '.pdf' : 'PICKING-' + commande.numero + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=' + fileName);
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Liste de Picking' + (isParallele ? ' - Mode Parallele' : ' - Mode Serie'), { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Infos
  doc.fontSize(10).font('Helvetica');
  doc.text('Commande: ' + commande.numero);
  doc.text('Client: ' + commande.nomClient + ' - ' + commande.adresseClient);
  doc.text('Date picking: ' + commande.listePicking.dateGeneration.toLocaleDateString('fr-FR'));
  
  if (isMAG) {
    doc.font('Helvetica-Bold').text('Magasinier: ' + req.user.prenom + ' ' + req.user.nom);
    doc.font('Helvetica');
  }
  doc.text('Nombre d\'articles: ' + lignes.length);
  doc.moveDown();

  if (isParallele) {
    // Grouper par zone
    const zonesMap = {};
    lignes.forEach(l => {
      const zoneName = l.article.emplacement ? l.article.emplacement.zone.code : 'NON_AFFECTE';
      if (!zonesMap[zoneName]) zonesMap[zoneName] = { lignes: [], magasinier: null };
      zonesMap[zoneName].lignes.push(l);
      if (l.magasinier) zonesMap[zoneName].magasinier = l.magasinier;
    });

    Object.keys(zonesMap).forEach(zone => {
      // Titre zone
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(12);
      const magName = zonesMap[zone].magasinier ? zonesMap[zone].magasinier.prenom + ' ' + zonesMap[zone].magasinier.nom : 'Non affecte';
      doc.text('Zone: ' + zone + '  |  Magasinier: ' + magName + '  |  ' + zonesMap[zone].lignes.length + ' article(s)');
      doc.moveDown(0.5);

      // Tableau
      const tableTop = doc.y;
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Reference', 50, tableTop, { width: 70 });
      doc.text('Designation', 120, tableTop, { width: 140 });
      doc.text('Emplacement', 260, tableTop, { width: 80 });
      doc.text('Qte', 340, tableTop, { width: 40 });
      doc.text('Preleve', 380, tableTop, { width: 50 });
      doc.text('OK', 440, tableTop, { width: 40 });
      
      doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
      
      doc.font('Helvetica').fontSize(9);
      let y = tableTop + 25;
      
      zonesMap[zone].lignes.forEach(l => {
        if (y > 700) { doc.addPage(); y = 50; }
        const emp = l.article.emplacement ? l.article.emplacement.code : 'N/A';
        doc.text(l.article.reference, 50, y, { width: 70 });
        doc.text(l.article.designation, 120, y, { width: 140 });
        doc.text(emp, 260, y, { width: 80 });
        doc.text(String(l.quantite), 340, y, { width: 40 });
        doc.text(String(l.quantitePrelevee), 380, y, { width: 50 });
        doc.rect(445, y - 2, 15, 15).stroke();
        y += 25;
      });

      doc.y = y + 10;
      doc.moveDown();
    });

  } else {
    // Mode série - tableau unique
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    const tableTop = doc.y + 10;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Reference', 50, tableTop, { width: 70 });
    doc.text('Designation', 120, tableTop, { width: 130 });
    doc.text('Zone', 250, tableTop, { width: 60 });
    doc.text('Emplacement', 310, tableTop, { width: 80 });
    doc.text('Qte', 390, tableTop, { width: 40 });
    doc.text('Preleve', 430, tableTop, { width: 50 });
    doc.text('OK', 490, tableTop, { width: 40 });
    
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
    
    doc.font('Helvetica').fontSize(9);
    let y = tableTop + 25;
    
    lignes.forEach(l => {
      if (y > 700) { doc.addPage(); y = 50; }
      const zone = l.article.emplacement ? l.article.emplacement.zone.code : 'N/A';
      const emp = l.article.emplacement ? l.article.emplacement.code : 'N/A';
      doc.text(l.article.reference, 50, y, { width: 70 });
      doc.text(l.article.designation, 120, y, { width: 130 });
      doc.text(zone, 250, y, { width: 60 });
      doc.text(emp, 310, y, { width: 80 });
      doc.text(String(l.quantite), 390, y, { width: 40 });
      doc.text(String(l.quantitePrelevee), 430, y, { width: 50 });
      doc.rect(495, y - 2, 15, 15).stroke();
      y += 25;
    });
  }

  // Signature
  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica').fontSize(10);
  if (isMAG) {
    doc.text('Magasinier: ' + req.user.prenom + ' ' + req.user.nom + '     Signature: ________________     Date: ________________');
  } else {
    doc.text('Magasinier: ________________     Signature: ________________     Date: ________________');
  }

  // Pied de page
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

router.get('/facture/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });

  if (!commande) return res.status(404).send('Commande introuvable');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=FACTURE-' + commande.numero + '.pdf');
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('FACTURE', { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Infos facture (gauche) et client (droite)
  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Facture:', 50, infoY);
  doc.font('Helvetica');
  doc.text('N° Facture: FAC-' + commande.numero, 50, infoY + 15);
  doc.text('N° Commande: ' + commande.numero, 50, infoY + 30);
  doc.text('Date commande: ' + commande.date.toLocaleDateString('fr-FR'), 50, infoY + 45);
  if (commande.dateExpedition) {
    doc.text('Date facturation: ' + commande.dateExpedition.toLocaleDateString('fr-FR'), 50, infoY + 60);
  }

  doc.font('Helvetica-Bold').text('Facture a:', 350, infoY);
  doc.font('Helvetica');
  doc.text(commande.nomClient, 350, infoY + 15);
  doc.text(commande.emailClient, 350, infoY + 30);
  doc.text(commande.adresseClient, 350, infoY + 45);

  doc.y = infoY + 90;
  doc.moveDown();

  // Tableau des articles
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Reference', 50, tableTop, { width: 80 });
  doc.text('Designation', 130, tableTop, { width: 160 });
  doc.text('Qte', 290, tableTop, { width: 40 });
  doc.text('Prix unit. HT', 330, tableTop, { width: 80 });
  doc.text('Total HT', 410, tableTop, { width: 80 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(10);
  let y = tableTop + 25;
  let totalHT = 0;
  
  commande.lignes.forEach(ligne => {
    const qte = ligne.quantitePreparee || ligne.quantite;
    const totalLigne = qte * ligne.article.prix;
    totalHT += totalLigne;
    
    doc.text(ligne.article.reference, 50, y, { width: 80 });
    doc.text(ligne.article.designation, 130, y, { width: 160 });
    doc.text(String(qte), 290, y, { width: 40 });
    doc.text(ligne.article.prix.toFixed(2) + ' DH', 330, y, { width: 80 });
    doc.text(totalLigne.toFixed(2) + ' DH', 410, y, { width: 80 });
    y += 20;
  });

  // Totaux
  const tva = totalHT * 0.20;
  const totalTTC = totalHT + tva;
  
  doc.moveTo(50, y + 5).lineTo(550, y + 5).stroke();
  y += 20;
  
  doc.font('Helvetica').fontSize(10);
  doc.text('Sous-total HT:', 330, y);
  doc.text(totalHT.toFixed(2) + ' DH', 450, y);
  y += 20;
  doc.text('TVA (20%):', 330, y);
  doc.text(tva.toFixed(2) + ' DH', 450, y);
  y += 20;
  doc.moveTo(330, y).lineTo(550, y).stroke();
  y += 10;
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text('Total TTC:', 330, y);
  doc.text(totalTTC.toFixed(2) + ' DH', 450, y);

  // Conditions de paiement
  doc.moveDown(5);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(10).text('Conditions de paiement:');
  doc.font('Helvetica').fontSize(9);
  doc.text('Paiement a 30 jours a compter de la date de facturation.');
  doc.text('Tout retard de paiement entrainera des penalites de retard.');

  // Signatures
  doc.moveDown(2);
  const sigY = doc.y;
  doc.text('Cachet et signature:', 50, sigY);
  doc.text('Bon pour accord client:', 350, sigY);
  doc.moveTo(50, sigY + 35).lineTo(200, sigY + 35).stroke();
  doc.moveTo(350, sigY + 35).lineTo(500, sigY + 35).stroke();

  // Pied de page
  doc.moveDown(4);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(8).text('WMS ENSIAS - Document genere automatiquement le ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});
router.post('/affecter-picking/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { zones, magasinierIds, magasinierSerie } = req.body;
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { 
      listePicking: { 
        include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } } 
      } 
    }
  });

  if (magasinierSerie) {
    // Mode série : affecter toutes les lignes au même magasinier
    const magId = parseInt(magasinierSerie);
    for (const ligne of commande.listePicking.lignes) {
      await prisma.lignePicking.update({
        where: { id: ligne.id },
        data: { magasinierId: magId }
      });
    }
    const magasinier = await prisma.utilisateur.findUnique({ where: { id: magId } });
    await prisma.notification.create({
      data: {
        message: `📋 Picking série - Commande ${commande.numero} : vous êtes affecté à la préparation de ${commande.listePicking.lignes.length} article(s). Veuillez prélever.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'MAGASINIER'
      }
    });
  } else {
    // Mode parallèle : affecter par zone
    const zonesList = Array.isArray(zones) ? zones : [zones];
    const magIds = Array.isArray(magasinierIds) ? magasinierIds : [magasinierIds];

    for (let i = 0; i < zonesList.length; i++) {
      const zone = zonesList[i];
      const magId = parseInt(magIds[i]);
      
      if (!magId) continue;
      
      for (const ligne of commande.listePicking.lignes) {
        const ligneZone = ligne.article.emplacement ? ligne.article.emplacement.zone.code : 'NON_AFFECTE';
        if (ligneZone === zone) {
          await prisma.lignePicking.update({
            where: { id: ligne.id },
            data: { magasinierId: magId }
          });
        }
      }
      
      await prisma.notification.create({
        data: {
          message: `📋 Picking parallèle - Commande ${commande.numero} : vous êtes affecté à la Zone ${zone}. Veuillez prélever les articles.`,
          lien: '/commandes/picking/' + commandeId,
          destinataireRole: 'MAGASINIER'
        }
      });
    }
  }

  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/relancer-backorder/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'EN_ATTENTE' }
  });

  const commande = await prisma.commande.findUnique({ where: { id: commandeId } });

  await prisma.notification.create({
    data: {
      message: `📦 Backorder ${commande.numero} relancé ! La commande est maintenant en attente de picking.`,
      lien: '/commandes',
      destinataireRole: 'RESPONSABLE_COMMANDE'
    }
  });

  res.redirect('/commandes');
});

// Page chargement camion
router.get('/chargement', async (req, res) => {
  const commandes = await prisma.commande.findMany({
    where: { statut: 'AU_QUAI' },
    include: { lignes: { include: { article: true } } }
  });
  res.render('commandes/chargement', { commandes });
});

// Expédier le camion
router.post('/expedier-camion', async (req, res) => {
  const { commandeIds, ordresLivraison, mode, immatriculation, chauffeur, poidsMax } = req.body;
  
  const ids = Array.isArray(commandeIds) ? commandeIds : [commandeIds];
  const ordres = Array.isArray(ordresLivraison) ? ordresLivraison : [ordresLivraison];
  
  // Créer la liste avec ordre de livraison
  const commandesAvecOrdre = [];
  for (let i = 0; i < ids.length; i++) {
    const commande = await prisma.commande.findUnique({
      where: { id: parseInt(ids[i]) },
      include: { lignes: { include: { article: true } } }
    });
    commandesAvecOrdre.push({
      commande,
      ordreLivraison: parseInt(ordres[i])
    });
  }
  
  // Trier par ordre de livraison
  commandesAvecOrdre.sort((a, b) => a.ordreLivraison - b.ordreLivraison);
  
  // Calculer l'ordre de chargement selon le mode
  let ordreChargement;
  if (mode === 'LIFO') {
    // LIFO : charger dans l'ordre inverse de livraison
    ordreChargement = [...commandesAvecOrdre].reverse();
  } else {
    // FIFO : charger dans le même ordre que livraison
    ordreChargement = [...commandesAvecOrdre];
  }
  
  // Expédier toutes les commandes
  for (const item of commandesAvecOrdre) {
    const cmd = item.commande;
    
    for (const ligne of cmd.lignes) {
      const qte = ligne.quantitePreparee || ligne.quantite;
      await prisma.mouvementStock.create({
        data: {
          type: 'SORTIE',
          quantite: qte,
          articleId: ligne.articleId
        }
      });
    }
    
    await prisma.commande.update({
      where: { id: cmd.id },
      data: { statut: 'EXPEDIEE', dateExpedition: new Date() }
    });
    
    // Vérifier alertes stock bas
    for (const ligne of cmd.lignes) {
      const article = await prisma.article.findUnique({ 
        where: { id: ligne.articleId },
        include: { mouvements: true }
      });
      const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
      const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
      const stockActuel = entrees - sorties;
      
      if (stockActuel <= article.seuilAlerte) {
        await prisma.notification.create({
          data: {
            message: '🔴 ALERTE STOCK BAS : ' + article.reference + ' - ' + article.designation + ' (Stock: ' + stockActuel + ', Seuil: ' + article.seuilAlerte + ')',
            lien: '/articles/stock',
            destinataireRole: 'RESPONSABLE_ENTREPOT'
          }
        });
      }
    }
  }

  await prisma.notification.create({
    data: {
      message: `🚚 Camion expédié ! ${commandesAvecOrdre.length} commande(s) en mode ${mode}. Ordre de livraison : ${commandesAvecOrdre.map(c => c.commande.numero + ' → ' + c.commande.nomClient).join(', ')}.`,
      lien: '/commandes',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  // Stocker en session pour le PDF
  req.session.dernierChargement = {
    mode,
    immatriculation,
    chauffeur,
    poidsMax,
    commandesLivraison: commandesAvecOrdre.map((c, i) => ({
      ordre: i + 1,
      numero: c.commande.numero,
      client: c.commande.nomClient,
      adresse: c.commande.adresseClient,
      nbArticles: c.commande.lignes.length,
      prixTotal: c.commande.prixTotal
    })),
    commandesChargement: ordreChargement.map((c, i) => ({
      ordre: i + 1,
      numero: c.commande.numero,
      client: c.commande.nomClient,
      adresse: c.commande.adresseClient,
      nbArticles: c.commande.lignes.length,
      prixTotal: c.commande.prixTotal
    }))
  };

  res.redirect('/commandes/chargement-resultat');
});

// Résultat du chargement
router.get('/chargement-resultat', async (req, res) => {
  const chargement = req.session.dernierChargement;
  if (!chargement) return res.redirect('/commandes');
  res.render('commandes/chargement-resultat', { chargement });
});

// PDF ordre de chargement
router.get('/chargement-pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const chargement = req.session.dernierChargement;
  if (!chargement) return res.status(404).send('Aucun chargement');

  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=CHARGEMENT-CAMION.pdf');
  doc.pipe(res);

  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('ORDRE DE CHARGEMENT CAMION', { align: 'center' });
  doc.fontSize(11).text('Mode : ' + chargement.mode, { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  doc.text('Date : ' + new Date().toLocaleDateString('fr-FR'));
  doc.text('Nombre de commandes : ' + chargement.commandesChargement.length);
  doc.moveDown();

  // Infos camion
  doc.font('Helvetica-Bold').fontSize(11).text('Informations Camion :');
  doc.font('Helvetica').fontSize(10);
  doc.text('Immatriculation : ' + (chargement.immatriculation || '-'));
  doc.text('Chauffeur : ' + (chargement.chauffeur || '-'));
  doc.text('Poids max : ' + (chargement.poidsMax || '-') + ' kg');
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Ordre de chargement
  doc.font('Helvetica-Bold').fontSize(13).text('1. ORDRE DE CHARGEMENT (dans le camion)', { underline: true });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(9);
  if (chargement.mode === 'LIFO') {
    doc.text('Mode LIFO : charger en premier ce qui sera livré en dernier (fond du camion).', { italic: true });
  } else {
    doc.text('Mode FIFO : charger en premier ce qui sera livré en premier.', { italic: true });
  }
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  let tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Charger', 50, tableTop, { width: 50 });
  doc.text('Commande', 100, tableTop, { width: 80 });
  doc.text('Client', 180, tableTop, { width: 130 });
  doc.text('Adresse', 310, tableTop, { width: 150 });
  doc.text('Articles', 460, tableTop, { width: 50 });
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  doc.font('Helvetica').fontSize(9);
  let y = tableTop + 25;
  chargement.commandesChargement.forEach(c => {
    doc.text('#' + c.ordre, 50, y, { width: 50 });
    doc.text(c.numero, 100, y, { width: 80 });
    doc.text(c.client, 180, y, { width: 130 });
    doc.text(c.adresse, 310, y, { width: 150 });
    doc.text(String(c.nbArticles), 460, y, { width: 50 });
    y += 20;
  });

  doc.moveDown(3);

  // Ordre de livraison
  doc.font('Helvetica-Bold').fontSize(13).text('2. ORDRE DE LIVRAISON (sur la route)', { underline: true });
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Livrer', 50, tableTop, { width: 50 });
  doc.text('Commande', 100, tableTop, { width: 80 });
  doc.text('Client', 180, tableTop, { width: 130 });
  doc.text('Adresse', 310, tableTop, { width: 150 });
  doc.text('Total', 460, tableTop, { width: 80 });
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  doc.font('Helvetica').fontSize(9);
  y = tableTop + 25;
  chargement.commandesLivraison.forEach(c => {
    doc.text('#' + c.ordre, 50, y, { width: 50 });
    doc.text(c.numero, 100, y, { width: 80 });
    doc.text(c.client, 180, y, { width: 130 });
    doc.text(c.adresse, 310, y, { width: 150 });
    doc.text(c.prixTotal.toFixed(2) + ' DH', 460, y, { width: 80 });
    y += 20;
  });

  // Signatures
  doc.moveDown(4);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica').fontSize(10);
  doc.text('Chauffeur (' + (chargement.chauffeur || '________') + '): ________________');
  doc.moveDown();
  doc.text('Resp. Commande: ________________     Date: ________________');
  doc.moveDown();
  doc.text('Immatriculation camion: ' + (chargement.immatriculation || '________'));

  doc.moveDown(2);
  doc.fontSize(8).text('WMS ENSIAS - Document genere automatiquement le ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});
module.exports = router;