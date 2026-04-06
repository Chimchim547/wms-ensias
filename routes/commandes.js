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
    include: { lignes: { include: { article: true } }, listePicking: true },
    orderBy: { date: 'desc' }
  });
  
  res.render('commandes/index', { 
    commandes, 
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
  
  const existant = await prisma.listePicking.findUnique({
    where: { commandeId: commandeId }
  });
  
  if (existant) {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: true } } }
  });
  
  const lignesPicking = commande.lignes.map(l => ({
    articleId: l.articleId,
    quantite: l.quantite
  }));
  
  await prisma.listePicking.create({
    data: {
      commandeId,
      lignes: { create: lignesPicking }
    }
  });
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'PICKING' }
  });

  // Notif pour le magasinier
  await prisma.notification.create({
    data: {
      message: `Commande ${commande.numero} : liste de picking générée. Veuillez prélever les ${commande.lignes.length} articles.`,
      lien: '/commandes/picking/' + commandeId,
      destinataireRole: 'MAGASINIER'
    }
  });

  res.redirect('/commandes');
});

router.get('/picking/:id', async (req, res) => {
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } },
      listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } } }
    }
  });
  res.render('commandes/picking', { commande });
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
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PREPARE' }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : le client accepte l'expédition partielle. Veuillez déplacer les articles vers le quai.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'MAGASINIER'
      }
    });
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
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'ANNULEE' }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} annulée par le client. Les articles doivent être remis en stock.`,
        lien: '/commandes',
        destinataireRole: 'MAGASINIER'
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
      listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } } }
    }
  });

  if (!commande || !commande.listePicking) return res.status(404).send('Picking introuvable');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=PICKING-' + commande.numero + '.pdf');
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Liste de Picking', { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Infos
  doc.fontSize(10).font('Helvetica');
  doc.text('Commande: ' + commande.numero);
  doc.text('Client: ' + commande.nomClient + ' - ' + commande.adresseClient);
  doc.text('Date picking: ' + commande.listePicking.dateGeneration.toLocaleDateString('fr-FR'));
  doc.text('Nombre d\'articles: ' + commande.listePicking.lignes.length);
  doc.moveDown();

  // Tableau
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
  
  commande.listePicking.lignes.forEach(ligne => {
    const zone = ligne.article.emplacement ? ligne.article.emplacement.zone.code : 'N/A';
    const emp = ligne.article.emplacement ? ligne.article.emplacement.code : 'N/A';
    
    doc.text(ligne.article.reference, 50, y, { width: 70 });
    doc.text(ligne.article.designation, 120, y, { width: 130 });
    doc.text(zone, 250, y, { width: 60 });
    doc.text(emp, 310, y, { width: 80 });
    doc.text(String(ligne.quantite), 390, y, { width: 40 });
    doc.text(String(ligne.quantitePrelevee), 430, y, { width: 50 });
    // Case à cocher
    doc.rect(495, y - 2, 15, 15).stroke();
    y += 25;
  });

  // Zone de notes
  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(10).text('Notes du magasinier:');
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();

  // Signature
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(10);
  doc.text('Magasinier: ________________     Date: ________________     Signature: ________________');

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
module.exports = router;