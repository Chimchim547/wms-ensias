const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: { include: { categorie: true } }, articles: true, stockEmplacements: { include: { article: true } } }
  });
  res.render('emplacements/index', { emplacements });
});

router.get('/create', async (req, res) => {
  const zones = await prisma.zone.findMany();
  res.render('emplacements/create', { zones });
});

router.post('/create', async (req, res) => {
  const { code, longueur, largeur, hauteur, poidsMax, zoneId } = req.body;
  await prisma.emplacement.create({
    data: {
      code,
      longueur: parseFloat(longueur), largeur: parseFloat(largeur),
      hauteur: parseFloat(hauteur), poidsMax: parseFloat(poidsMax),
      zoneId: parseInt(zoneId)
    }
  });
  res.redirect('/emplacements');
});

router.post('/delete/:id', async (req, res) => {
  await prisma.emplacement.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/emplacements');
});

router.get('/affecter', async (req, res) => {
  const articlesAll = await prisma.article.findMany({
    include: { mouvements: true, categorie: true, emplacement: { include: { zone: true } } }
  });
  
  const toutesRepartitions = await prisma.stockEmplacement.findMany();
  
  const articlesFiltres = articlesAll.filter(a => {
    const entrees = a.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = a.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    a.stockActuel = entrees - sorties;
    if (a.stockActuel <= 0) return false;
    const repartitions = toutesRepartitions.filter(r => r.articleId === a.id);
    a.stockReparti = repartitions.reduce((sum, r) => sum + r.quantite, 0);
    a.stockAAffecter = a.stockActuel - a.stockReparti;
    if (a.emplacement) {
      a.emplacementActuel = a.emplacement.code + ' (' + a.emplacement.zone.code + ')';
    }
    return a.stockAAffecter > 0;
  });

  const emplacements = await prisma.emplacement.findMany({
    include: { zone: { include: { categorie: true } }, articles: true, stockEmplacements: { include: { article: true } } }
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
  
  const articles = articlesFiltres.map(article => {
    const poidsTotal = article.stockAAffecter * article.poids;
    const compatibles = emplacementsDisponibles.filter(e => {
      if (e.zone.type !== 'stockage') return false;
      if (e.zone.categorieId && article.categorieId !== e.zone.categorieId) return false;
      if (article.longueur > e.longueur || article.largeur > e.largeur || article.hauteur > e.hauteur) return false;
      if (article.longueur > e.zone.dimensionMaxLongueur || article.largeur > e.zone.dimensionMaxLargeur || article.hauteur > e.zone.dimensionMaxHauteur) return false;
      if (article.poids > e.poidsMax) return false;
      if (article.poids > e.zone.poidsMax) return false;
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
      return { ...e, capaciteMax };
    });
    const capaciteTotale = compatiblesAvecCapacite.reduce((sum, e) => sum + e.capaciteMax, 0);
    const besoinRepartition = article.stockAAffecter > 0 && compatiblesAvecCapacite.length > 0 && !compatiblesAvecCapacite.some(e => e.capaciteMax >= article.stockAAffecter);
    return { 
      ...article, 
      compatibles: compatiblesAvecCapacite, 
      poidsTotal: poidsTotal.toFixed(1),
      capaciteTotale,
      besoinRepartition
    };
  });
  
  const magasiniers = await prisma.utilisateur.findMany({ where: { role: 'MAGASINIER' } });
  
  res.render('emplacements/affecter', { articles, emplacements: emplacementsDisponibles, magasiniers });
});

router.post('/affecter', async (req, res) => {
  const { articleId, emplacementId, magasinierId } = req.body;
  const article = await prisma.article.findUnique({ 
    where: { id: parseInt(articleId) },
    include: { mouvements: true }
  });
  const emplacement = await prisma.emplacement.findUnique({
    where: { id: parseInt(emplacementId) },
    include: { zone: true, stockEmplacements: true }
  });
  
  const problemes = [];
  if (article.longueur > emplacement.longueur) problemes.push('Longueur: ' + article.longueur + ' > ' + emplacement.longueur);
  if (article.largeur > emplacement.largeur) problemes.push('Largeur: ' + article.largeur + ' > ' + emplacement.largeur);
  if (article.hauteur > emplacement.hauteur) problemes.push('Hauteur: ' + article.hauteur + ' > ' + emplacement.hauteur);
  if (article.poids > emplacement.poidsMax) problemes.push('Poids: ' + article.poids + ' > ' + emplacement.poidsMax);
  
  if (problemes.length > 0) {
    return res.render('emplacements/erreur-affectation', { article, emplacement, problemes });
  }
  
  const volEmp = emplacement.longueur * emplacement.largeur * emplacement.hauteur;
  const volArt = article.longueur * article.largeur * article.hauteur;
  const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
  const capPoids = article.poids > 0 ? Math.floor(emplacement.poidsMax / article.poids) : capVolume;
  const capaciteMax = Math.min(capVolume, capPoids);
  
  const dejaStockeDansEmp = emplacement.stockEmplacements.reduce((sum, s) => sum + s.quantite, 0);
  const capaciteRestante = capaciteMax - dejaStockeDansEmp;
  
  const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
  const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
  const stockTotal = entrees - sorties;
  
  const stockDejaReparti = await prisma.stockEmplacement.aggregate({
    where: { articleId: parseInt(articleId) },
    _sum: { quantite: true }
  });
  const dejaReparti = stockDejaReparti._sum.quantite || 0;
  const resteAAffecter = stockTotal - dejaReparti;
  const quantiteAAffecter = Math.min(capaciteRestante, resteAAffecter);
  
  if (quantiteAAffecter <= 0) {
    return res.render('emplacements/erreur-affectation', {
      article, emplacement,
      problemes: [capaciteRestante <= 0 ? 'Cet emplacement est plein.' : 'Tout le stock est déjà réparti.']
    });
  }
  
  await prisma.stockEmplacement.upsert({
    where: { articleId_emplacementId: { articleId: parseInt(articleId), emplacementId: parseInt(emplacementId) } },
    create: { articleId: parseInt(articleId), emplacementId: parseInt(emplacementId), quantite: quantiteAAffecter },
    update: { quantite: { increment: quantiteAAffecter } }
  });
  
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(emplacementId) }
  });

  const totalRepartiApres = dejaReparti + quantiteAAffecter;
  const resteApres = stockTotal - totalRepartiApres;

  // Créer mission pour le magasinier
  const magId = magasinierId ? parseInt(magasinierId) : null;
  
  if (magId) {
    await prisma.missionAffectation.create({
      data: {
        articleId: parseInt(articleId),
        emplacementId: parseInt(emplacementId),
        quantite: quantiteAAffecter,
        magasinierId: magId
      }
    });

    await prisma.notification.create({
      data: {
        message: `Nouvelle affectation : ${article.reference} - ${article.designation} (${quantiteAAffecter} unités) vers ${emplacement.code} (Zone ${emplacement.zone.code}). Veuillez déplacer les articles.`,
        lien: '/emplacements/mes-affectations',
        destinataireRole: 'MAGASINIER'
      }
    });
  }

  let message = article.reference + ' : ' + quantiteAAffecter + ' unité(s) vers ' + emplacement.code + ' (' + emplacement.zone.code + ').';
  if (resteApres > 0) message += ' Reste ' + resteApres + ' à affecter.';
  else message += ' Tout le stock est réparti.';

  await prisma.notification.create({
    data: { message, lien: '/zones/plan', destinataireRole: 'RESPONSABLE_ENTREPOT' }
  });

  res.redirect('/emplacements/affecter');
});

// === MES AFFECTATIONS ===
router.get('/mes-affectations', async (req, res) => {
  const missions = await prisma.missionAffectation.findMany({
    where: { magasinierId: req.user.id },
    include: { article: true, emplacement: { include: { zone: true } }, magasinier: true },
    orderBy: { dateCreation: 'desc' }
  });
  res.render('emplacements/mes-affectations', { missions });
});

router.post('/valider-affectation/:id', async (req, res) => {
  const missionId = parseInt(req.params.id);
  await prisma.missionAffectation.update({
    where: { id: missionId },
    data: { statut: 'TERMINE', dateValidation: new Date() }
  });
  const mission = await prisma.missionAffectation.findUnique({
    where: { id: missionId },
    include: { article: true, emplacement: { include: { zone: true } }, magasinier: true }
  });
  await prisma.notification.create({
    data: {
      message: `Affectation terminée par ${mission.magasinier.prenom} : ${mission.article.reference} (${mission.quantite}) vers ${mission.emplacement.code}`,
      lien: '/zones/plan',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });
  res.redirect('/emplacements/mes-affectations');
});

// PDF mission
router.get('/affectation-pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const mission = await prisma.missionAffectation.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { article: true, emplacement: { include: { zone: true } }, magasinier: true }
  });
  if (!mission) return res.status(404).send('Mission introuvable');
  
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=AFFECTATION-' + mission.id + '.pdf');
  doc.pipe(res);
  
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Mission de Mise en Stock', { align: 'center' });
  doc.moveDown(); doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke(); doc.moveDown();
  
  doc.fontSize(10).font('Helvetica');
  doc.text('Mission N: AFF-' + mission.id);
  doc.text('Date: ' + mission.dateCreation.toLocaleDateString('fr-FR'));
  doc.text('Magasinier: ' + mission.magasinier.prenom + ' ' + mission.magasinier.nom);
  doc.text('Statut: ' + (mission.statut === 'TERMINE' ? 'Terminee' : 'En cours'));
  doc.moveDown();
  
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke(); doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(12).text('Article a deplacer :');
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10);
  doc.text('Reference: ' + mission.article.reference);
  doc.text('Designation: ' + mission.article.designation);
  doc.text('Quantite: ' + mission.quantite + ' unite(s)');
  doc.text('Poids unitaire: ' + mission.article.poids + ' kg');
  doc.text('Poids total: ' + (mission.quantite * mission.article.poids).toFixed(1) + ' kg');
  doc.text('Dimensions: ' + mission.article.longueur + ' x ' + mission.article.largeur + ' x ' + mission.article.hauteur + ' cm');
  doc.moveDown();
  
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke(); doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(12).text('Source :');
  doc.font('Helvetica').fontSize(10).text('Zone de reception (quai)');
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(12).text('Destination :');
  doc.font('Helvetica').fontSize(10);
  doc.text('Emplacement: ' + mission.emplacement.code);
  doc.text('Zone: ' + mission.emplacement.zone.code + ' (' + mission.emplacement.zone.nom + ')');
  doc.text('Dimensions: ' + mission.emplacement.longueur + ' x ' + mission.emplacement.largeur + ' x ' + mission.emplacement.hauteur + ' cm');
  doc.text('Poids max: ' + mission.emplacement.poidsMax + ' kg');
  doc.moveDown(2);
  
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke(); doc.moveDown();
  const sigY = doc.y;
  doc.fontSize(9);
  doc.text('Magasinier: ' + mission.magasinier.prenom + ' ' + mission.magasinier.nom, 50, sigY);
  doc.text('Resp. Entrepot:', 350, sigY);
  doc.moveTo(50, sigY + 30).lineTo(200, sigY + 30).stroke();
  doc.moveTo(350, sigY + 30).lineTo(500, sigY + 30).stroke();
  doc.text('Date: ________________', 50, sigY + 40);
  doc.text('Date: ________________', 350, sigY + 40);
  doc.moveDown(4);
  doc.fontSize(8).text('WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });
  doc.end();
});
// === SUIVI AFFECTATIONS (Resp. Entrepôt) ===
router.get('/suivi-affectations', async (req, res) => {
  const missions = await prisma.missionAffectation.findMany({
    include: { article: true, emplacement: { include: { zone: true } }, magasinier: true },
    orderBy: { dateCreation: 'desc' }
  });
  res.render('emplacements/suivi-affectations', { missions });
});

module.exports = router;