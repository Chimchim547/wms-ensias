const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const { statut, recherche, dateDebut, dateFin } = req.query;
  const where = {};
  if (statut) where.statut = statut;
  if (recherche) {
    where.OR = [
      { numero: { contains: recherche, mode: 'insensitive' } },
      { nomClient: { contains: recherche, mode: 'insensitive' } }
    ];
  }
  if (dateDebut || dateFin) {
    where.date = {};
    if (dateDebut) where.date.gte = new Date(dateDebut);
    if (dateFin) { const fin = new Date(dateFin); fin.setHours(23,59,59); where.date.lte = fin; }
  }
  
  const commandes = await prisma.commande.findMany({
    where,
    include: { lignes: { include: { article: { include: { mouvements: true } } } }, listePicking: true, backorders: true },
    orderBy: { date: 'desc' }
  });

  for (const cmd of commandes) {
    if (cmd.statut === 'BACKORDER' || cmd.statut === 'EN_ATTENTE_STOCK') {
      cmd.stockDispo = true;
      for (const ligne of cmd.lignes) {
        const entrees = ligne.article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
        const sorties = ligne.article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
        if (entrees - sorties < ligne.quantite) { cmd.stockDispo = false; break; }
      }
    }
  }
  
  const magasiniers = await prisma.utilisateur.findMany({ where: { role: 'MAGASINIER' } });
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

// ===== CLIENTS =====
router.get('/clients', async (req, res) => {
  const clients = await prisma.client.findMany({ include: { commandes: true } });
  res.render('commandes/clients', { clients });
});



// ===== CREATE COMMANDE =====
router.get('/create', async (req, res) => {
  const articles = await prisma.article.findMany();
  res.render('commandes/create', { articles });
});

router.post('/create', async (req, res) => {
  try {
    const { numero, nomClient, emailClient, adresseClient, telephoneClient, articleIds, quantites } = req.body;
    const lignes = [];
    const ids = Array.isArray(articleIds) ? articleIds : [articleIds];
    const qtes = Array.isArray(quantites) ? quantites : [quantites];
    let prixTotal = 0;
    
    for (let i = 0; i < ids.length; i++) {
      const article = await prisma.article.findUnique({ where: { id: parseInt(ids[i]) } });
      prixTotal += article.prix * parseInt(qtes[i]);
      lignes.push({ articleId: parseInt(ids[i]), quantite: parseInt(qtes[i]) });
    }
    
    // Auto-créer ou mettre à jour le client
    let client = await prisma.client.findFirst({ where: { OR: [{ email: emailClient }, { telephone: telephoneClient || '' }] } });
    if (!client) {
      client = await prisma.client.create({ data: { nom: nomClient, email: emailClient, adresse: adresseClient, telephone: telephoneClient || '' } });
    } else {
      await prisma.client.update({ where: { id: client.id }, data: { nom: nomClient, adresse: adresseClient, telephone: telephoneClient || client.telephone } });
    }
    
    await prisma.commande.create({
      data: {
        numero, nomClient, emailClient, adresseClient, telephoneClient, prixTotal,
        statut: 'EN_ATTENTE', clientId: client.id,
        lignes: { create: lignes }
      }
    });

    res.redirect('/commandes');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

// ===== PICKING =====
router.post('/picking/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const modePicking = req.body.modePicking || 'SERIE';
  
  const existant = await prisma.listePicking.findUnique({ where: { commandeId } });
  if (existant) return res.redirect('/commandes/picking/' + commandeId);
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } }
  });
  
  await prisma.listePicking.create({
    data: {
      commandeId, modePicking,
      lignes: { create: commande.lignes.map(l => ({ articleId: l.articleId, quantite: l.quantite })) }
    }
  });
  
  await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'PICKING' } });

  const zones = new Set();
  commande.lignes.forEach(l => { if (l.article.emplacement && l.article.emplacement.zone) zones.add(l.article.emplacement.zone.code); });

  const magasinierSerieId = req.body.magasinierSerie ? parseInt(req.body.magasinierSerie) : null;

  if (modePicking === 'SERIE' && magasinierSerieId) {
    const listePicking = await prisma.listePicking.findUnique({ where: { commandeId }, include: { lignes: true } });
    for (const ligne of listePicking.lignes) {
      await prisma.lignePicking.update({ where: { id: ligne.id }, data: { magasinierId: magasinierSerieId } });
    }
    await prisma.notification.create({
      data: { message: `Picking série - Commande ${commande.numero} : vous êtes affecté à la préparation de ${commande.lignes.length} article(s).`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'MAGASINIER' }
    });
  } else if (modePicking === 'PARALLELE') {
    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} : picking parallèle généré. Veuillez affecter les magasiniers par zone.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'RESPONSABLE_COMMANDE' }
    });
    return res.redirect('/commandes/picking/' + commandeId);
  } else {
    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} : liste de picking générée. Veuillez affecter un magasinier.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'RESPONSABLE_COMMANDE' }
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
  const magasiniers = await prisma.utilisateur.findMany({ where: { role: 'MAGASINIER' } });
  res.render('commandes/picking', { commande, magasiniers });
});

router.post('/preparer/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { ligneIds, quantitesPrelevees } = req.body;
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { listePicking: { include: { lignes: true } }, lignes: true }
  });
  
  if (['PREPARE','AU_QUAI','EXPEDIEE'].includes(commande.statut)) return res.redirect('/commandes/picking/' + commandeId);
  
  const ids = Array.isArray(ligneIds) ? ligneIds : [ligneIds];
  const qps = Array.isArray(quantitesPrelevees) ? quantitesPrelevees : [quantitesPrelevees];
  
  let toutComplet = true;
  for (let i = 0; i < ids.length; i++) {
    const qp = parseInt(qps[i]) || 0;
    const ligne = commande.listePicking.lignes.find(l => l.id === parseInt(ids[i]));
    if (qp < ligne.quantite) toutComplet = false;
    await prisma.lignePicking.update({ where: { id: parseInt(ids[i]) }, data: { quantitePrelevee: qp } });
  }
  
  for (let i = 0; i < commande.lignes.length; i++) {
    const lignePicking = commande.listePicking.lignes.find(l => l.articleId === commande.lignes[i].articleId);
    const idx = ids.indexOf(String(lignePicking.id));
    const qp = parseInt(qps[idx]) || 0;
    await prisma.ligneCommande.update({ where: { id: commande.lignes[i].id }, data: { quantitePreparee: qp } });
  }
  
  if (toutComplet) {
    await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'PREPARE' } });
    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} : tous les articles prélevés. Prête pour le quai.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'RESPONSABLE_COMMANDE' }
    });
  } else {
    await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'PARTIELLE' } });
    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} : préparation partielle ! Votre décision est requise.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'RESPONSABLE_COMMANDE' }
    });
  }
  res.redirect('/commandes/picking/' + commandeId);
});

// ===== DECISION =====
router.post('/decision/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { decision } = req.body;
  const commande = await prisma.commande.findUnique({ where: { id: commandeId } });
  
  if (decision === 'expedier_partiel') {
    const commandeComplete = await prisma.commande.findUnique({
      where: { id: commandeId },
      include: { lignes: { include: { article: true } }, listePicking: { include: { lignes: true } } }
    });

    const lignesBackorder = [];
    let prixBackorder = 0;

    for (const ligne of commandeComplete.lignes) {
      const lignePicking = commandeComplete.listePicking.lignes.find(l => l.articleId === ligne.articleId);
      const qtePrelevee = lignePicking ? lignePicking.quantitePrelevee : 0;
      const qteManquante = ligne.quantite - qtePrelevee;
      if (qteManquante > 0) {
        prixBackorder += qteManquante * ligne.article.prix;
        lignesBackorder.push({ articleId: ligne.articleId, quantite: qteManquante });
      }
    }

    if (lignesBackorder.length > 0) {
      const backorder = await prisma.commande.create({
        data: {
          numero: commande.numero + '-B', nomClient: commande.nomClient, emailClient: commande.emailClient,
          adresseClient: commande.adresseClient, telephoneClient: commande.telephoneClient,
          prixTotal: prixBackorder, statut: 'BACKORDER', commandeParentId: commandeId,
          clientId: commande.clientId,
          lignes: { create: lignesBackorder }
        }
      });
      await prisma.notification.create({
        data: { message: `Backorder ${backorder.numero} créé (${lignesBackorder.length} article(s), ${prixBackorder.toFixed(2)} DH).`, lien: '/commandes', destinataireRole: 'RESPONSABLE_ENTREPOT' }
      });
    }

    let prixPartiel = 0;
    for (const ligne of commandeComplete.lignes) {
      const lignePicking = commandeComplete.listePicking.lignes.find(l => l.articleId === ligne.articleId);
      prixPartiel += (lignePicking ? lignePicking.quantitePrelevee : 0) * ligne.article.prix;
    }

    await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'PREPARE', prixTotal: prixPartiel } });

    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} : expédition partielle acceptée. Déplacez vers le quai.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'MAGASINIER' }
    });

    if (lignesBackorder.length > 0) {
      const arts = [];
      for (const lb of lignesBackorder) { const a = await prisma.article.findUnique({ where: { id: lb.articleId } }); arts.push(a.reference + ' (qte: ' + lb.quantite + ')'); }
      await prisma.notification.create({
        data: { message: 'RÉAPPROVISIONNEMENT URGENT : ' + arts.join(', '), lien: '/reception/create', destinataireRole: 'RESPONSABLE_RECEPTION' }
      });
    }

  } else if (decision === 'attendre') {
    await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'EN_ATTENTE_STOCK' } });
    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} : le client préfère attendre. En attente de réapprovisionnement.`, lien: '/commandes', destinataireRole: 'RESPONSABLE_ENTREPOT' }
    });

    const commandeComplete = await prisma.commande.findUnique({
      where: { id: commandeId },
      include: { lignes: { include: { article: true } }, listePicking: { include: { lignes: true } } }
    });
    const arts = [];
    for (const ligne of commandeComplete.lignes) {
      const lp = commandeComplete.listePicking ? commandeComplete.listePicking.lignes.find(l => l.articleId === ligne.articleId) : null;
      const manq = ligne.quantite - (lp ? lp.quantitePrelevee : 0);
      if (manq > 0) arts.push(ligne.article.reference + ' (qte: ' + manq + ')');
    }
    if (arts.length > 0) {
      await prisma.notification.create({
        data: { message: 'RÉAPPROVISIONNEMENT NÉCESSAIRE : ' + arts.join(', '), lien: '/reception/create', destinataireRole: 'RESPONSABLE_RECEPTION' }
      });
    }

  } else if (decision === 'annuler') {
    const commandeComplete = await prisma.commande.findUnique({
      where: { id: commandeId },
      include: { lignes: { include: { article: true } }, listePicking: { include: { lignes: { include: { article: true } } } } }
    });
    const arts = [];
    for (const ligne of commandeComplete.listePicking.lignes) {
      if (ligne.quantitePrelevee > 0) arts.push(ligne.article.reference + ' (qte: ' + ligne.quantitePrelevee + ')');
    }
    await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'ANNULEE' } });
    if (arts.length > 0) {
      await prisma.notification.create({
        data: { message: `Commande ${commande.numero} ANNULÉE. Articles à remettre : ${arts.join(', ')}.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'MAGASINIER' }
      });
    }
    await prisma.notification.create({
      data: { message: `Commande ${commande.numero} annulée.`, lien: '/commandes', destinataireRole: 'RESPONSABLE_ENTREPOT' }
    });
  }
  res.redirect('/commandes/picking/' + commandeId);
});

// ===== QUAI & EXPEDITION =====
router.post('/deplacer-quai/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId }, include: { lignes: { include: { article: true } } }
  });
  if (['AU_QUAI','EXPEDIEE'].includes(commande.statut)) return res.redirect('/commandes/picking/' + commandeId);
  
  for (const ligne of commande.lignes) {
    if (ligne.article.emplacementId) {
      await prisma.article.update({ where: { id: ligne.articleId }, data: { emplacementId: null } });
      await prisma.mouvementStock.create({ data: { type: 'TRANSFERT', quantite: ligne.quantitePreparee || ligne.quantite, articleId: ligne.articleId } });
    }
  }
  await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'AU_QUAI' } });
  await prisma.notification.create({
    data: { message: `Commande ${commande.numero} : articles au quai. Vous pouvez expédier.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'RESPONSABLE_COMMANDE' }
  });
  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/expedier/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({ where: { id: commandeId }, include: { lignes: true } });
  if (commande.statut === 'EXPEDIEE') return res.redirect('/commandes');
  
  for (const ligne of commande.lignes) {
    await prisma.mouvementStock.create({ data: { type: 'SORTIE', quantite: ligne.quantitePreparee || ligne.quantite, articleId: ligne.articleId } });
  }
  await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'EXPEDIEE', dateExpedition: new Date() } });

  for (const ligne of commande.lignes) {
    const article = await prisma.article.findUnique({ where: { id: ligne.articleId }, include: { mouvements: true } });
    const ent = article.mouvements.filter(m => m.type === 'ENTREE').reduce((s, m) => s + m.quantite, 0);
    const sor = article.mouvements.filter(m => m.type === 'SORTIE').reduce((s, m) => s + m.quantite, 0);
    if (ent - sor <= article.seuilAlerte) {
      await prisma.notification.create({
        data: { message: 'ALERTE STOCK BAS : ' + article.reference + ' (Stock: ' + (ent-sor) + ', Seuil: ' + article.seuilAlerte + ')', lien: '/articles/stock', destinataireRole: 'RESPONSABLE_ENTREPOT' }
      });
    }
  }
  await prisma.notification.create({
    data: { message: `Commande ${commande.numero} expédiée. Stock mis à jour.`, lien: '/articles/stock', destinataireRole: 'RESPONSABLE_ENTREPOT' }
  });
  res.redirect('/commandes');
});

// ===== AFFECTER PICKING =====
router.post('/affecter-picking/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { zones, magasinierIds, magasinierSerie } = req.body;
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } } } }
  });

  if (magasinierSerie) {
    const magId = parseInt(magasinierSerie);
    for (const ligne of commande.listePicking.lignes) { await prisma.lignePicking.update({ where: { id: ligne.id }, data: { magasinierId: magId } }); }
    await prisma.notification.create({ data: { message: `Picking série - Commande ${commande.numero} : préparation affectée.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'MAGASINIER' } });
  } else {
    const zonesList = Array.isArray(zones) ? zones : [zones];
    const magIds = Array.isArray(magasinierIds) ? magasinierIds : [magasinierIds];
    for (let i = 0; i < zonesList.length; i++) {
      const magId = parseInt(magIds[i]);
      if (!magId) continue;
      for (const ligne of commande.listePicking.lignes) {
        const z = ligne.article.emplacement ? ligne.article.emplacement.zone.code : 'NON_AFFECTE';
        if (z === zonesList[i]) await prisma.lignePicking.update({ where: { id: ligne.id }, data: { magasinierId: magId } });
      }
      await prisma.notification.create({ data: { message: `Picking parallèle - Commande ${commande.numero} : Zone ${zonesList[i]} affectée.`, lien: '/commandes/picking/' + commandeId, destinataireRole: 'MAGASINIER' } });
    }
  }
  res.redirect('/commandes/picking/' + commandeId);
});

// ===== RELANCER =====
router.post('/relancer-backorder/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'EN_ATTENTE' } });
  const commande = await prisma.commande.findUnique({ where: { id: commandeId } });
  await prisma.notification.create({ data: { message: `Backorder ${commande.numero} relancé !`, lien: '/commandes', destinataireRole: 'RESPONSABLE_COMMANDE' } });
  res.redirect('/commandes');
});

router.post('/relancer-attente/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const ancienPicking = await prisma.listePicking.findUnique({ where: { commandeId }, include: { lignes: true } });
  if (ancienPicking) {
    await prisma.lignePicking.deleteMany({ where: { listePickingId: ancienPicking.id } });
    await prisma.listePicking.delete({ where: { id: ancienPicking.id } });
  }
  await prisma.ligneCommande.updateMany({ where: { commandeId }, data: { quantitePreparee: 0 } });
  await prisma.commande.update({ where: { id: commandeId }, data: { statut: 'EN_ATTENTE' } });
  const commande = await prisma.commande.findUnique({ where: { id: commandeId } });
  await prisma.notification.create({ data: { message: 'Commande ' + commande.numero + ' relancée ! Stock disponible.', lien: '/commandes', destinataireRole: 'RESPONSABLE_COMMANDE' } });
  res.redirect('/commandes');
});

// ===== CHARGEMENT =====
router.get('/chargement', async (req, res) => {
  const commandes = await prisma.commande.findMany({ where: { statut: 'AU_QUAI' }, include: { lignes: { include: { article: true } } } });
  res.render('commandes/chargement', { commandes });
});

router.post('/expedier-camion', async (req, res) => {
  const { commandeIds, ordresLivraison, mode, immatriculation, chauffeur, poidsMax } = req.body;
  const ids = Array.isArray(commandeIds) ? commandeIds : [commandeIds];
  const ordres = Array.isArray(ordresLivraison) ? ordresLivraison : [ordresLivraison];
  
  const commandesAvecOrdre = [];
  for (let i = 0; i < ids.length; i++) {
    const commande = await prisma.commande.findUnique({ where: { id: parseInt(ids[i]) }, include: { lignes: { include: { article: true } } } });
    commandesAvecOrdre.push({ commande, ordreLivraison: parseInt(ordres[i]) });
  }
  commandesAvecOrdre.sort((a, b) => a.ordreLivraison - b.ordreLivraison);
  const ordreChargement = mode === 'LIFO' ? [...commandesAvecOrdre].reverse() : [...commandesAvecOrdre];
  
  for (const item of commandesAvecOrdre) {
    for (const ligne of item.commande.lignes) {
      await prisma.mouvementStock.create({ data: { type: 'SORTIE', quantite: ligne.quantitePreparee || ligne.quantite, articleId: ligne.articleId } });
    }
    await prisma.commande.update({ where: { id: item.commande.id }, data: { statut: 'EXPEDIEE', dateExpedition: new Date() } });
    for (const ligne of item.commande.lignes) {
      const article = await prisma.article.findUnique({ where: { id: ligne.articleId }, include: { mouvements: true } });
      const ent = article.mouvements.filter(m => m.type === 'ENTREE').reduce((s,m) => s+m.quantite, 0);
      const sor = article.mouvements.filter(m => m.type === 'SORTIE').reduce((s,m) => s+m.quantite, 0);
      if (ent-sor <= article.seuilAlerte) {
        await prisma.notification.create({ data: { message: 'ALERTE STOCK BAS : ' + article.reference + ' (Stock: ' + (ent-sor) + ')', lien: '/articles/stock', destinataireRole: 'RESPONSABLE_ENTREPOT' } });
      }
    }
  }

  await prisma.notification.create({
    data: { message: `Camion expédié ! ${commandesAvecOrdre.length} commande(s) en mode ${mode}.`, lien: '/commandes', destinataireRole: 'RESPONSABLE_ENTREPOT' }
  });

  req.session.dernierChargement = {
    mode, immatriculation, chauffeur, poidsMax,
    commandesLivraison: commandesAvecOrdre.map((c, i) => ({ ordre: i+1, numero: c.commande.numero, client: c.commande.nomClient, adresse: c.commande.adresseClient, nbArticles: c.commande.lignes.length, prixTotal: c.commande.prixTotal })),
    commandesChargement: ordreChargement.map((c, i) => ({ ordre: i+1, numero: c.commande.numero, client: c.commande.nomClient, adresse: c.commande.adresseClient, nbArticles: c.commande.lignes.length, prixTotal: c.commande.prixTotal }))
  };
  res.redirect('/commandes/chargement-resultat');
});

router.get('/chargement-resultat', async (req, res) => {
  const chargement = req.session.dernierChargement;
  if (!chargement) return res.redirect('/commandes');
  res.render('commandes/chargement-resultat', { chargement });
});

// ===== PDFs =====
router.get('/pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const commande = await prisma.commande.findUnique({ where: { id: parseInt(req.params.id) }, include: { lignes: { include: { article: true } } } });
  if (!commande) return res.status(404).send('Commande introuvable');
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=BL-' + commande.numero + '.pdf');
  doc.pipe(res);
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Bon de Livraison', { align: 'center' });
  doc.moveDown(); doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke(); doc.moveDown();
  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Commande:', 50, infoY);
  doc.font('Helvetica');
  doc.text('Numero: ' + commande.numero, 50, infoY + 15);
  doc.text('Date: ' + commande.date.toLocaleDateString('fr-FR'), 50, infoY + 30);
  if (commande.dateExpedition) doc.text('Expedition: ' + commande.dateExpedition.toLocaleDateString('fr-FR'), 50, infoY + 45);
  doc.font('Helvetica-Bold').text('Client:', 350, infoY);
  doc.font('Helvetica');
  doc.text(commande.nomClient, 350, infoY + 15);
  doc.text(commande.emailClient, 350, infoY + 30);
  doc.text(commande.adresseClient, 350, infoY + 45);
  if (commande.telephoneClient) doc.text('Tel: ' + commande.telephoneClient, 350, infoY + 60);
  doc.y = infoY + 80; doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Reference', 50, tableTop, { width: 90 }); doc.text('Designation', 140, tableTop, { width: 170 });
  doc.text('Qte', 310, tableTop, { width: 50 }); doc.text('Prix unit.', 360, tableTop, { width: 80 }); doc.text('Total', 440, tableTop, { width: 80 });
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  doc.font('Helvetica').fontSize(10);
  let y = tableTop + 25; let totalGeneral = 0;
  commande.lignes.forEach(l => {
    const qte = l.quantitePreparee || l.quantite; const total = qte * l.article.prix; totalGeneral += total;
    doc.text(l.article.reference, 50, y, { width: 90 }); doc.text(l.article.designation, 140, y, { width: 170 });
    doc.text(String(qte), 310, y, { width: 50 }); doc.text(l.article.prix.toFixed(2) + ' DH', 360, y, { width: 80 }); doc.text(total.toFixed(2) + ' DH', 440, y, { width: 80 });
    y += 20;
  });
  doc.moveTo(50, y+5).lineTo(550, y+5).stroke(); y += 15;
  doc.font('Helvetica-Bold').fontSize(12); doc.text('Total:', 360, y); doc.text(totalGeneral.toFixed(2) + ' DH', 440, y);
  doc.moveDown(5); doc.fontSize(10).font('Helvetica');
  doc.text('Signature expediteur: ________________', 50); doc.text('Signature client: ________________', 350);
  doc.moveDown(3); doc.fontSize(9).text('WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });
  doc.end();
});

router.get('/facture/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const commande = await prisma.commande.findUnique({ where: { id: parseInt(req.params.id) }, include: { lignes: { include: { article: true } } } });
  if (!commande) return res.status(404).send('Commande introuvable');
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=FACTURE-' + commande.numero + '.pdf');
  doc.pipe(res);
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('FACTURE', { align: 'center' });
  doc.moveDown(); doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke(); doc.moveDown();
  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Facture:', 50, infoY);
  doc.font('Helvetica');
  doc.text('N° FAC-' + commande.numero, 50, infoY + 15);
  doc.text('Commande: ' + commande.numero, 50, infoY + 30);
  doc.text('Date: ' + commande.date.toLocaleDateString('fr-FR'), 50, infoY + 45);
  if (commande.dateExpedition) doc.text('Facturation: ' + commande.dateExpedition.toLocaleDateString('fr-FR'), 50, infoY + 60);
  doc.font('Helvetica-Bold').text('Client:', 350, infoY);
  doc.font('Helvetica');
  doc.text(commande.nomClient, 350, infoY + 15); doc.text(commande.emailClient, 350, infoY + 30);
  doc.text(commande.adresseClient, 350, infoY + 45);
  if (commande.telephoneClient) doc.text('Tel: ' + commande.telephoneClient, 350, infoY + 60);
  doc.y = infoY + 80; doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const t2 = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Reference', 50, t2, { width: 80 }); doc.text('Designation', 130, t2, { width: 160 });
  doc.text('Qte', 290, t2, { width: 40 }); doc.text('Prix HT', 330, t2, { width: 80 }); doc.text('Total HT', 410, t2, { width: 80 });
  doc.moveTo(50, t2 + 15).lineTo(550, t2 + 15).stroke();
  doc.font('Helvetica').fontSize(10);
  let yf = t2 + 25; let totalHT = 0;
  commande.lignes.forEach(l => {
    const qte = l.quantitePreparee || l.quantite; const tot = qte * l.article.prix; totalHT += tot;
    doc.text(l.article.reference, 50, yf, { width: 80 }); doc.text(l.article.designation, 130, yf, { width: 160 });
    doc.text(String(qte), 290, yf, { width: 40 }); doc.text(l.article.prix.toFixed(2) + ' DH', 330, yf, { width: 80 }); doc.text(tot.toFixed(2) + ' DH', 410, yf, { width: 80 });
    yf += 20;
  });
  const tva = totalHT * 0.20; const totalTTC = totalHT + tva;
  doc.moveTo(50, yf+5).lineTo(550, yf+5).stroke(); yf += 20;
  doc.text('Sous-total HT:', 330, yf); doc.text(totalHT.toFixed(2) + ' DH', 450, yf); yf += 20;
  doc.text('TVA (20%):', 330, yf); doc.text(tva.toFixed(2) + ' DH', 450, yf); yf += 20;
  doc.moveTo(330, yf).lineTo(550, yf).stroke(); yf += 10;
  doc.font('Helvetica-Bold').fontSize(12); doc.text('Total TTC:', 330, yf); doc.text(totalTTC.toFixed(2) + ' DH', 450, yf);
  doc.moveDown(4); doc.font('Helvetica').fontSize(9);
  doc.text('Paiement a 30 jours.'); doc.moveDown(2);
  doc.text('Signature: ________________', 50); doc.text('Client: ________________', 350);
  doc.moveDown(3); doc.fontSize(8).text('WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });
  doc.end();
});

router.get('/picking-pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } }, listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } }, magasinier: true } } } } }
  });
  if (!commande || !commande.listePicking) return res.status(404).send('Picking introuvable');
  const isParallele = commande.listePicking.modePicking === 'PARALLELE';
  const isMAG = req.user.role === 'MAGASINIER';
  let lignes = commande.listePicking.lignes;
  if (isMAG && isParallele) lignes = lignes.filter(l => l.magasinierId === req.user.id);
  if (lignes.length === 0) return res.status(404).send('Aucun article');
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=PICKING-' + commande.numero + '.pdf');
  doc.pipe(res);
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Liste de Picking - Mode ' + commande.listePicking.modePicking, { align: 'center' });
  doc.moveDown(); doc.fontSize(10).font('Helvetica');
  doc.text('Commande: ' + commande.numero); doc.text('Client: ' + commande.nomClient);
  if (isMAG) doc.font('Helvetica-Bold').text('Magasinier: ' + req.user.prenom + ' ' + req.user.nom);
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tp = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Reference', 50, tp); doc.text('Designation', 120, tp); doc.text('Zone', 260, tp); doc.text('Empl.', 320, tp); doc.text('Qte', 390, tp); doc.text('Preleve', 430, tp);
  doc.moveTo(50, tp+15).lineTo(550, tp+15).stroke();
  doc.font('Helvetica').fontSize(9);
  let yp = tp + 25;
  lignes.forEach(l => {
    if (yp > 700) { doc.addPage(); yp = 50; }
    doc.text(l.article.reference, 50, yp); doc.text(l.article.designation, 120, yp);
    doc.text(l.article.emplacement ? l.article.emplacement.zone.code : 'N/A', 260, yp);
    doc.text(l.article.emplacement ? l.article.emplacement.code : 'N/A', 320, yp);
    doc.text(String(l.quantite), 390, yp); doc.text(String(l.quantitePrelevee), 430, yp);
    yp += 20;
  });
  doc.moveDown(3); doc.fontSize(10);
  doc.text('Magasinier: ________________     Signature: ________________');
  doc.moveDown(2); doc.fontSize(8).text('WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });
  doc.end();
});

router.get('/chargement-pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const chargement = req.session.dernierChargement;
  if (!chargement) return res.status(404).send('Aucun chargement');
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=CHARGEMENT.pdf');
  doc.pipe(res);
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('ORDRE DE CHARGEMENT - Mode ' + chargement.mode, { align: 'center' });
  doc.moveDown(); doc.fontSize(10).font('Helvetica');
  doc.text('Immatriculation: ' + (chargement.immatriculation || '-'));
  doc.text('Chauffeur: ' + (chargement.chauffeur || '-'));
  doc.text('Poids max: ' + (chargement.poidsMax || '-') + ' kg');
  doc.moveDown();
  doc.font('Helvetica-Bold').text('Ordre de chargement:'); doc.moveDown(0.5);
  chargement.commandesChargement.forEach(c => { doc.font('Helvetica').text('#' + c.ordre + ' - ' + c.numero + ' → ' + c.client + ' (' + c.adresse + ')'); });
  doc.moveDown();
  doc.font('Helvetica-Bold').text('Ordre de livraison:'); doc.moveDown(0.5);
  chargement.commandesLivraison.forEach(c => { doc.font('Helvetica').text('#' + c.ordre + ' - ' + c.numero + ' → ' + c.client + ' - ' + c.prixTotal.toFixed(2) + ' DH'); });
  doc.moveDown(3);
  doc.text('Chauffeur: ________________     Resp. Commande: ________________');
  doc.moveDown(2); doc.fontSize(8).text('WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });
  doc.end();
});

module.exports = router;
