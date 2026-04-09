const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const { type, recherche } = req.query;
  
  const where = {};
  
  if (type) {
    where.type = type;
  }
  
  if (req.user.role === 'RESPONSABLE_RECEPTION') {
    where.type = 'ENTREE';
  } else if (req.user.role === 'RESPONSABLE_COMMANDE') {
    where.type = 'SORTIE';
  }
  
  const mouvements = await prisma.mouvementStock.findMany({
    where,
    include: { article: true },
    orderBy: { date: 'desc' }
  });
  
  res.render('mouvements/index', { mouvements, filtres: { type: type || '' } });
});

router.get('/transfert', async (req, res) => {
  // Charger les articles qui ont des stockEmplacements
  const stockEmplacements = await prisma.stockEmplacement.findMany({
    include: { 
      article: { include: { categorie: true } }, 
      emplacement: { include: { zone: { include: { categorie: true } } } } 
    }
  });
  
  // Grouper par article avec leurs emplacements actuels
  const articlesMap = {};
  stockEmplacements.forEach(se => {
    if (!articlesMap[se.articleId]) {
      articlesMap[se.articleId] = {
        ...se.article,
        emplacementsActuels: [],
        totalStocke: 0
      };
    }
    articlesMap[se.articleId].emplacementsActuels.push({
      code: se.emplacement.code,
      zone: se.emplacement.zone.code,
      quantite: se.quantite,
      emplacementId: se.emplacementId
    });
    articlesMap[se.articleId].totalStocke += se.quantite;
  });
  
  const articles = Object.values(articlesMap);
  
  // Charger tous les emplacements disponibles (libres ou partiels du même article)
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: { include: { categorie: true } }, stockEmplacements: { include: { article: true } } }
  });
  
  const emplacementsDisponibles = emplacements.filter(e => {
    const qteStockee = e.stockEmplacements.reduce((sum, s) => sum + s.quantite, 0);
    e.qteStockee = qteStockee;
    e.capaciteRestante = undefined;
    e.articleStockeId = null;
    
    if (qteStockee === 0) return true;
    
    if (e.stockEmplacements.length > 0) {
      const art = e.stockEmplacements[0].article;
      const volEmp = e.longueur * e.largeur * e.hauteur;
      const volArt = art.longueur * art.largeur * art.hauteur;
      const capVol = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
      const capPoids = art.poids > 0 ? Math.floor(e.poidsMax / art.poids) : capVol;
      const capMax = Math.min(capVol, capPoids);
      e.capaciteRestante = capMax - qteStockee;
      e.articleStockeId = art.id;
      return e.capaciteRestante > 0;
    }
    return false;
  });
  
  // Pour chaque article, trouver les emplacements compatibles
  const articlesWithCompatible = articles.map(article => {
    const compatibles = emplacementsDisponibles.filter(e => {
      // Filtrer par type de zone (stockage uniquement)
      if (e.zone.type !== 'stockage') return false;
      // Filtrer par catégorie de zone
      if (e.zone.categorieId && article.categorieId !== e.zone.categorieId) return false;
      // Filtrer par dimensions
      if (article.longueur > e.longueur || article.largeur > e.largeur || article.hauteur > e.hauteur) return false;
      if (article.longueur > e.zone.dimensionMaxLongueur || article.largeur > e.zone.dimensionMaxLargeur || article.hauteur > e.zone.dimensionMaxHauteur) return false;
      // Filtrer par poids
      if (article.poids > e.poidsMax) return false;
      if (article.poids > e.zone.poidsMax) return false;
      // Si contient un autre article, pas compatible
      if (e.articleStockeId && e.articleStockeId !== article.id) return false;
      
      return true;
    });

    const compatiblesAvecCapacite = compatibles.map(e => {
      const volEmp = e.longueur * e.largeur * e.hauteur;
      const volArt = article.longueur * article.largeur * article.hauteur;
      const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
      const capPoids = article.poids > 0 ? Math.floor(e.poidsMax / article.poids) : capVolume;
      let capaciteMax = Math.min(capVolume, capPoids);
      if (e.capaciteRestante !== undefined && e.capaciteRestante < capaciteMax) {
        capaciteMax = e.capaciteRestante;
      }
      return { 
        id: e.id, 
        code: e.code, 
        zone: e.zone.code,
        categorie: e.zone.categorie ? e.zone.categorie.nom : 'Toutes',
        longueur: e.longueur, 
        largeur: e.largeur, 
        hauteur: e.hauteur, 
        poidsMax: e.poidsMax, 
        capaciteMax 
      };
    });

    return { 
      ...article, 
      compatibles: compatiblesAvecCapacite
    };
  });
  
  res.render('mouvements/transfert', { articles: articlesWithCompatible, emplacements: emplacementsDisponibles });
});

router.post('/transfert', async (req, res) => {
  const { articleId, sourceEmplacementId, newEmplacementId, quantite } = req.body;
  
  const artId = parseInt(articleId);
  const srcId = parseInt(sourceEmplacementId);
  const destId = parseInt(newEmplacementId);
  const qte = parseInt(quantite) || 1;
  
  const article = await prisma.article.findUnique({ where: { id: artId } });
  const srcEmplacement = await prisma.emplacement.findUnique({ where: { id: srcId } });
  const destEmplacement = await prisma.emplacement.findUnique({ 
    where: { id: destId },
    include: { zone: true }
  });
  
  // Calculer capacité destination
  const volEmp = destEmplacement.longueur * destEmplacement.largeur * destEmplacement.hauteur;
  const volArt = article.longueur * article.largeur * article.hauteur;
  const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
  const capPoids = article.poids > 0 ? Math.floor(destEmplacement.poidsMax / article.poids) : capVolume;
  const capaciteMax = Math.min(capVolume, capPoids);
  
  // Stock déjà dans la destination
  const destStock = await prisma.stockEmplacement.findUnique({
    where: { articleId_emplacementId: { articleId: artId, emplacementId: destId } }
  });
  const dejaEnDest = destStock ? destStock.quantite : 0;
  const capaciteRestante = capaciteMax - dejaEnDest;
  
  const qteEffective = Math.min(qte, capaciteRestante);
  
  if (qteEffective <= 0) {
    return res.redirect('/mouvements/transfert');
  }
  
  // Retirer de la source
  const srcStock = await prisma.stockEmplacement.findUnique({
    where: { articleId_emplacementId: { articleId: artId, emplacementId: srcId } }
  });
  
  if (!srcStock || srcStock.quantite < qteEffective) {
    return res.redirect('/mouvements/transfert');
  }
  
  if (srcStock.quantite === qteEffective) {
    await prisma.stockEmplacement.delete({
      where: { articleId_emplacementId: { articleId: artId, emplacementId: srcId } }
    });
  } else {
    await prisma.stockEmplacement.update({
      where: { articleId_emplacementId: { articleId: artId, emplacementId: srcId } },
      data: { quantite: { decrement: qteEffective } }
    });
  }
  
  // Ajouter à la destination
  await prisma.stockEmplacement.upsert({
    where: { articleId_emplacementId: { articleId: artId, emplacementId: destId } },
    create: { articleId: artId, emplacementId: destId, quantite: qteEffective },
    update: { quantite: { increment: qteEffective } }
  });
  
  // Mettre à jour emplacementId
  await prisma.article.update({
    where: { id: artId },
    data: { emplacementId: destId }
  });
  
  // Mouvement de transfert
  await prisma.mouvementStock.create({
    data: {
      type: 'TRANSFERT',
      quantite: qteEffective,
      articleId: artId
    }
  });

  await prisma.notification.create({
    data: {
      message: article.reference + ' : ' + qteEffective + ' unité(s) déplacée(s) de ' + srcEmplacement.code + ' vers ' + destEmplacement.code + ' (Zone ' + destEmplacement.zone.code + ')',
      lien: '/zones/plan',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect('/mouvements');
});

router.get('/pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const { type } = req.query;
  
  const where = {};
  if (type) where.type = type;
  
  if (req.user.role === 'RESPONSABLE_RECEPTION') where.type = 'ENTREE';
  else if (req.user.role === 'RESPONSABLE_COMMANDE') where.type = 'SORTIE';
  
  const mouvements = await prisma.mouvementStock.findMany({
    where,
    include: { article: true },
    orderBy: { date: 'desc' }
  });

  const doc = new PDFDocument({ margin: 50 });
  const titre = type ? 'Mouvements - ' + type + 'S' : 'Tous les Mouvements de Stock';
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=MOUVEMENTS-' + new Date().toISOString().slice(0,10) + '.pdf');
  doc.pipe(res);

  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text(titre, { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  const entrees = mouvements.filter(m => m.type === 'ENTREE');
  const sorties = mouvements.filter(m => m.type === 'SORTIE');
  const transferts = mouvements.filter(m => m.type === 'TRANSFERT');
  
  doc.fontSize(10).font('Helvetica');
  doc.text('Date du rapport: ' + new Date().toLocaleDateString('fr-FR'));
  doc.text('Total mouvements: ' + mouvements.length + '  |  Entrees: ' + entrees.length + '  |  Sorties: ' + sorties.length + '  |  Transferts: ' + transferts.length);
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Date', 50, tableTop, { width: 70 });
  doc.text('Heure', 120, tableTop, { width: 50 });
  doc.text('Type', 170, tableTop, { width: 80 });
  doc.text('Reference', 250, tableTop, { width: 70 });
  doc.text('Designation', 320, tableTop, { width: 150 });
  doc.text('Qte', 470, tableTop, { width: 50 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(9);
  let y = tableTop + 25;
  
  mouvements.forEach(m => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    
    doc.text(m.date.toLocaleDateString('fr-FR'), 50, y, { width: 70 });
    doc.text(m.date.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'}), 120, y, { width: 50 });
    doc.text(m.type, 170, y, { width: 80 });
    doc.text(m.article.reference, 250, y, { width: 70 });
    doc.text(m.article.designation, 320, y, { width: 150 });
    doc.text(String(m.quantite), 470, y, { width: 50 });
    y += 18;
  });

  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica').fontSize(10);
  doc.text('Resp. Entrepot: ________________     Signature: ________________');
  doc.moveDown(2);
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

module.exports = router;